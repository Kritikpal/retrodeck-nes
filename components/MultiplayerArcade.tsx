"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ChangeEvent, PointerEvent as ReactPointerEvent } from "react";
import Link from "next/link";
import {
  ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Check, Clipboard, Gamepad2,
  Headphones, Link2, Pause, Play, RotateCcw, Upload, Users, Wifi, WifiOff, X,
} from "lucide-react";
import { BUTTON_BITS, NetplayNes, sampleGamepad } from "@/lib/nes-netplay";

type Phase = "offline" | "connecting" | "waiting" | "playing" | "paused" | "desync";
type Rom = { name: string; data: Uint8Array; hash: string; origin: "demo" | "local" };
type Frame = { frame: number; epoch: number; p1: number; p2: number };
type Incoming = Record<string, unknown> & { type: string };
type Lib = ConstructorParameters<typeof NetplayNes>[1];

const ROM_LIMIT = 10 * 1024 * 1024;
const INPUT_AHEAD = 8; // 133 ms of input buffering at 60 Hz; masks absorb jitter but add latency.
const FRAME_MS = 1000 / 60;
const KEYS: Record<string, number> = {
  ArrowUp: BUTTON_BITS.UP, ArrowDown: BUTTON_BITS.DOWN,
  ArrowLeft: BUTTON_BITS.LEFT, ArrowRight: BUTTON_BITS.RIGHT,
  KeyX: BUTTON_BITS.A, KeyZ: BUTTON_BITS.B,
  Enter: BUTTON_BITS.START, ShiftRight: BUTTON_BITS.SELECT,
};
const PAD = [
  { key: "UP", bit: BUTTON_BITS.UP, Icon: ArrowUp },
  { key: "LEFT", bit: BUTTON_BITS.LEFT, Icon: ArrowLeft },
  { key: "DOWN", bit: BUTTON_BITS.DOWN, Icon: ArrowDown },
  { key: "RIGHT", bit: BUTTON_BITS.RIGHT, Icon: ArrowRight },
] as const;

function isROM(data: Uint8Array) {
  return data.length >= 16 && data[0] === 0x4e && data[1] === 0x45 && data[2] === 0x53 && data[3] === 0x1a;
}
async function hashROM(bytes: Uint8Array) {
  if (!crypto.subtle) throw new Error("ROM verification requires HTTPS or localhost.");
  const copied = new Uint8Array(bytes.byteLength);
  copied.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copied.buffer);
  return Array.from(new Uint8Array(digest), (v) => v.toString(16).padStart(2, "0")).join("");
}
function socketUrl() {
  if (process.env.NEXT_PUBLIC_WS_URL) return process.env.NEXT_PUBLIC_WS_URL;
  const scheme = window.location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${window.location.hostname}:3001`;
}

export function MultiplayerArcade() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const engineRef = useRef<NetplayNes | null>(null);
  const libRef = useRef<Lib | null>(null);
  const selectedRef = useRef<Rom | null>(null);
  const framesRef = useRef(new Map<number, Frame>());
  const epochRef = useRef(0);
  const playedRef = useRef(0);
  const sentRef = useRef(-1);
  const lastTickRef = useRef(0);
  const bucketRef = useRef(0);
  const phaseRef = useRef<Phase>("offline");
  const pressRef = useRef(new Set<string>());
  const [phase, setPhase] = useState<Phase>("offline");
  const [rom, setRom] = useState<Rom | null>(null);
  const [room, setRoom] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [player, setPlayer] = useState<1 | 2 | null>(null);
  const [frameCount, setFrameCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [romBusy, setRomBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [waitingForFrame, setWaitingForFrame] = useState(false);

  const changePhase = useCallback((next: Phase) => { phaseRef.current = next; setPhase(next); }, []);
  const send = useCallback((payload: Record<string, unknown>) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify(payload));
  }, []);
  const cleanupEmulator = useCallback(() => {
    engineRef.current?.destroy();
    engineRef.current = null;
    framesRef.current.clear();
    playedRef.current = 0;
    sentRef.current = -1;
    bucketRef.current = 0;
    lastTickRef.current = 0;
    pressRef.current.clear();
    setFrameCount(0);
    setWaitingForFrame(false);
  }, []);
  const dropConnection = useCallback(() => {
    if (wsRef.current) {
      const socket = wsRef.current;
      wsRef.current = null;
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "leave" }));
      socket.close();
    }
    cleanupEmulator();
    setRoom("");
    setPlayer(null);
    changePhase("offline");
  }, [changePhase, cleanupEmulator]);

  useEffect(() => {
    let mounted = true;
    async function init() {
      try {
        const imported = (await import("jsnes")) as unknown as Lib;
        if (!mounted) return;
        libRef.current = imported;
        const response = await fetch("/roms/pixel-chase-duo.nes");
        if (!response.ok) throw new Error("Cannot load the two-player demo ROM.");
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (!mounted) return;
        const selection: Rom = { name: "Pixel Chase Duo", data: bytes, hash: await hashROM(bytes), origin: "demo" };
        if (!mounted) return;
        selectedRef.current = selection;
        setRom(selection);
      } catch (cause) {
        if (mounted) setError(cause instanceof Error ? cause.message : "Unable to initialize emulator.");
      } finally {
        if (mounted) setLoading(false);
      }
    }
    void init();
    const suggestedCode = new URLSearchParams(window.location.search).get("room");
    if (suggestedCode) setJoinCode(suggestedCode.toUpperCase().slice(0, 6));
    return () => {
      mounted = false;
      const socket = wsRef.current;
      wsRef.current = null;
      socket?.close();
      engineRef.current?.destroy();
      engineRef.current = null;
    };
  }, []);

  const queueInput = useCallback(() => {
    if (phaseRef.current !== "playing") return;
    while (sentRef.current < playedRef.current + INPUT_AHEAD - 1) {
      const next = ++sentRef.current;
      let mask = sampleGamepad();
      for (const key of pressRef.current) mask |= KEYS[key] ?? Number(key) ?? 0;
      send({ type: "input", epoch: epochRef.current, frame: next, mask });
    }
  }, [send]);

  // The only frame scheduler: never advance emulation until BOTH controller masks arrive.
  useEffect(() => {
    let raf = 0;
    const loop = (time: number) => {
      const active = phaseRef.current === "playing";
      if (active && engineRef.current) {
        const prev = lastTickRef.current || time;
        lastTickRef.current = time;
        bucketRef.current = Math.min(100, bucketRef.current + Math.min(100, time - prev));
        let steps = 0;
        while (bucketRef.current >= FRAME_MS && steps < 5) {
          const id = playedRef.current;
          const incoming = framesRef.current.get(id);
          if (!incoming) break;
          framesRef.current.delete(id);
          engineRef.current.frame(incoming.p1, incoming.p2);
          playedRef.current++;
          bucketRef.current -= FRAME_MS;
          steps++;
          if (playedRef.current % 30 === 0) setFrameCount(playedRef.current);
          if (playedRef.current % 300 === 0) {
            send({ type: "checksum", epoch: epochRef.current, frame: playedRef.current, hash: engineRef.current.checksum() });
          }
          queueInput();
        }
        setWaitingForFrame((old) => {
          const waiting = bucketRef.current >= FRAME_MS && !framesRef.current.has(playedRef.current);
          return waiting === old ? old : waiting;
        });
      } else lastTickRef.current = time;
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [queueInput, send]);

  useEffect(() => {
    const onDown = (event: KeyboardEvent) => {
      if (event.repeat || event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
      if (KEYS[event.code] && phaseRef.current === "playing") {
        event.preventDefault();
        pressRef.current.add(event.code);
        engineRef.current?.unlockAudio();
      }
    };
    const onUp = (event: KeyboardEvent) => {
      if (KEYS[event.code]) { pressRef.current.delete(event.code); if (phaseRef.current === "playing") event.preventDefault(); }
    };
    const release = () => pressRef.current.clear();
    const visibility = () => {
      if (document.hidden && phaseRef.current === "playing") send({ type: "pause", paused: true });
      if (document.hidden) engineRef.current?.pauseAudio();
    };
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    window.addEventListener("blur", release);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
      window.removeEventListener("blur", release);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [send]);

  const startEmulator = useCallback((epoch: number) => {
    const lib = libRef.current, cartridge = selectedRef.current, canvas = canvasRef.current;
    if (!lib || !cartridge || !canvas) { setError("Console is not ready. Rejoin the room."); return; }
    try {
      cleanupEmulator();
      engineRef.current = new NetplayNes(canvas, lib, cartridge.data);
      setError("");
      epochRef.current = epoch;
      changePhase("playing");
      setNotice("Both players connected. Match started at frame zero.");
      queueInput();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to start game.");
      changePhase("desync");
    }
  }, [changePhase, cleanupEmulator, queueInput]);

  const connect = useCallback((action: "create" | "join") => {
    if (phaseRef.current !== "offline" || !selectedRef.current || !libRef.current) return;
    if (action === "join" && !/^[A-HJ-NP-Z2-9]{6}$/.test(joinCode.trim().toUpperCase())) {
      setError("Enter the six-character room code."); return;
    }
    setError(""); setNotice("");
    changePhase("connecting");
    let socket: WebSocket;
    try { socket = new WebSocket(socketUrl()); }
    catch { setError("Invalid WebSocket server URL."); changePhase("offline"); return; }
    wsRef.current = socket;
    socket.onopen = () => {
      const cartridge = selectedRef.current;
      if (!cartridge) return;
      send(action === "create"
        ? { type: "create", romSha: cartridge.hash, romName: cartridge.name }
        : { type: "join", code: joinCode.trim().toUpperCase(), romSha: cartridge.hash });
    };
    socket.onmessage = (event: MessageEvent) => {
      let message: Incoming;
      try { message = JSON.parse(event.data) as Incoming; } catch { return; }
      if (message.type === "hello") {
        if (message.protocol !== 1) { setError("Server protocol version mismatch."); dropConnection(); }
      } else if (message.type === "room") {
        setRoom(String(message.code));
        setPlayer(message.player as 1 | 2);
        changePhase("waiting");
        setNotice(message.player === 1 ? "Room created. Share your code with Player 2." : "Joined room. Starting match...");
      } else if (message.type === "start") {
        if (typeof message.epoch === "number") startEmulator(message.epoch);
      } else if (message.type === "frame") {
        const m = message as Frame;
        if (m.epoch === epochRef.current && phaseRef.current === "playing" && Number.isInteger(m.frame) && m.frame >= playedRef.current && m.frame <= playedRef.current + 120) framesRef.current.set(m.frame, m);
      } else if (message.type === "pause") {
        if (message.epoch !== epochRef.current) return;
        if (message.paused) { engineRef.current?.pauseAudio(); changePhase("paused"); setNotice(`Paused by Player ${message.by}`); }
        else { changePhase("playing"); engineRef.current?.unlockAudio(); setNotice("Match resumed."); queueInput(); }
      } else if (message.type === "desync") {
        engineRef.current?.pauseAudio(); changePhase("desync");
        setError("Emulator states diverged. Either player can reset the match to re-synchronize.");
      } else if (message.type === "peer_left") {
        cleanupEmulator(); changePhase("waiting");
        setNotice("Player 2 disconnected. Share the room code to invite someone back.");
      } else if (message.type === "room_closed") {
        const reason = String(message.message ?? "Room closed.");
        dropConnection(); setError(reason);
      } else if (message.type === "error") {
        const reason = String(message.message ?? "Room request failed.");
        dropConnection(); setError(reason);
      }
    };
    socket.onerror = () => setError("Connection failed. Check the WebSocket relay and its allowed origin.");
    socket.onclose = () => {
      if (wsRef.current !== socket) return;
      dropConnection();
      setError((previous) => previous || "Connection lost. Create or join a room again.");
    };
  }, [changePhase, cleanupEmulator, dropConnection, joinCode, queueInput, send, startEmulator]);

  const loadFile = async (file?: File) => {
    if (!file || phaseRef.current !== "offline") return;
    setRomBusy(true); setError("");
    try {
      if (file.size > ROM_LIMIT || file.size < 16) throw new Error("Choose a valid NES ROM under 10 MB.");
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (!isROM(bytes)) throw new Error("This file does not have a valid NES header.");
      const selection: Rom = { name: file.name.replace(/\.nes$/i, ""), data: bytes, hash: await hashROM(bytes), origin: "local" };
      selectedRef.current = selection;
      setRom(selection);
      setNotice("ROM loaded locally. Your friend must choose the exact same file.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "ROM load failed."); }
    finally { setRomBusy(false); }
  };

  const loadDemo = async () => {
    if (phaseRef.current !== "offline") return;
    setRomBusy(true);
    try {
      const result = await fetch("/roms/pixel-chase-duo.nes");
      if (!result.ok) throw new Error("Demo ROM unavailable.");
      const data = new Uint8Array(await result.arrayBuffer());
      const selection: Rom = { name: "Pixel Chase Duo", data, hash: await hashROM(data), origin: "demo" };
      selectedRef.current = selection; setRom(selection); setError(""); setNotice("Two-player demo ready.");
    } catch (cause) { setError(String(cause)); }
    finally { setRomBusy(false); }
  };

  const touchProps = (bit: number) => ({
    onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => {
      event.preventDefault();
      if (phaseRef.current !== "playing") return;
      event.currentTarget.setPointerCapture(event.pointerId);
      pressRef.current.add(String(bit));
      engineRef.current?.unlockAudio();
    },
    onPointerUp: () => pressRef.current.delete(String(bit)),
    onPointerCancel: () => pressRef.current.delete(String(bit)),
    onLostPointerCapture: () => pressRef.current.delete(String(bit)),
  });

  const invite = room && typeof window !== "undefined" ? `${window.location.origin}/multiplayer?room=${room}` : "";
  const copyInvite = () => { if (invite) void navigator.clipboard.writeText(invite).then(() => setNotice("Invite link copied.")).catch(() => setError("Unable to copy. Copy the room code instead.")); };
  const active = phase === "playing";
  const connected = phase !== "offline" && phase !== "connecting";

  return (
    <main className="shell">
      <header className="topbar">
        <Link href="/" className="brand"><div className="brand-symbol"><Gamepad2 size={23} /></div><span className="brand-text">RETRO<span>DECK</span><small> / NES</small></span></Link>
        <nav className="topnav"><Link href="/">SOLO ARCADE</Link><span className="nav-active">ONLINE MULTIPLAYER</span></nav>
        <span className={`net-status ${active ? "online" : ""}`}><Wifi size={15} /> {active ? "MATCH LIVE" : "NETPLAY"}</span>
      </header>
      <div className="content">
        <div className="intro"><div><div className="eyebrow"><span className="signal" /> 2-PLAYER ONLINE ARCADE</div><h1>Play together.<br /><em>From anywhere.</em></h1><p>Create a room, share the link, and play a two-player NES game in sync.</p></div></div>
        <div className="main-grid">
          <section className="console-panel">
            <div className="console-heading"><div className="heading-left"><span className="console-status-dot" /> ONLINE CONSOLE <span className="console-divider">/</span> <span className="heading-muted">{player ? `PLAYER 0${player}` : "NO ROOM"}</span></div><div className="power-status"><span className={`power-light ${active ? "on" : ""}`} /> {phase.toUpperCase()}</div></div>
            <div className="tv-housing">
              <div className="display-bezel net-display"><canvas ref={canvasRef} aria-label="Online NES game display" className="net-canvas" />
                {!engineRef.current && <div className="empty-display"><Users size={40} color="#ac8eff" /><div className="empty-title">{phase === "waiting" ? "WAITING FOR P2" : "READY FOR TWO"}</div><div className="empty-sub">{phase === "waiting" ? "SHARE YOUR ROOM CODE" : "CREATE OR JOIN A GAME ROOM"}</div></div>}
                {(phase === "paused" || phase === "desync") && <div className="paused-overlay"><Pause size={28} />{phase === "desync" ? "SYNC ERROR" : "ROOM PAUSED"}</div>}
                <div className="scanlines" aria-hidden="true" />
              </div>
              <span className="screen-serial">RD-NETPLAY / 60 HZ</span><span className="screen-logo">LOCKSTEP™</span>
            </div>
            <div className="net-game-meta"><div><small>CARTRIDGE</small><strong>{rom?.name || "Loading demo..."}</strong><span>{rom ? `${rom.origin === "demo" ? "Included two-player demo" : "Local ROM"} · SHA256 ${rom.hash.slice(0, 12)}…` : "Preparing game"}</span></div><div className="net-frame"><small>FRAME</small><strong>{frameCount}</strong></div></div>
            <div className="net-commands"><button disabled={!connected || phase === "waiting" || phase === "desync"} onClick={() => send({ type: "pause", paused: active })}>{active ? <Pause size={16} /> : <Play size={16} />} {active ? "Pause both" : "Resume both"}</button><button disabled={!connected || phase === "waiting"} onClick={() => send({ type: "reset" })}><RotateCcw size={16} /> Reset both</button><button disabled={!active} onClick={() => engineRef.current?.unlockAudio()}><Headphones size={16} /> Enable sound</button></div>
            {active && waitingForFrame && <p className="net-wait"><WifiOff size={15} /> Waiting for synchronized inputs. Network latency can cause brief stalls.</p>}
          </section>
          <aside className="side-panel">
            <section className="card net-room-card"><div className="section-heading"><Users size={19} /><span>GAME ROOM</span><span className="small-counter">2 PLAYERS</span></div>
              {connected ? <>
                <div className="room-code"><small>INVITE CODE</small><strong>{room}</strong><span>You're Player {player}</span></div>
                <button className="room-primary" onClick={copyInvite}><Clipboard size={16} /> Copy invite link</button>
                <button className="room-secondary" onClick={dropConnection}><X size={16} /> Leave room</button>
                <p className="room-help">{phase === "waiting" ? "Open this invitation on a friend's device. They must load the same ROM to join." : "Both players run identical ROMs. Only controller inputs are exchanged."}</p>
              </> : <>
                <div className="room-step"><strong>1. Select an NES cartridge</strong><span>Use the included two-player demo or your own game.</span></div>
                <div className="room-rom-actions"><label className="room-secondary file-button"><Upload size={16} /> Upload .nes<input type="file" accept=".nes" disabled={loading || romBusy || phase !== "offline"} onChange={(e: ChangeEvent<HTMLInputElement>) => { void loadFile(e.target.files?.[0]); e.target.value = ""; }} /></label><button className="room-secondary" disabled={loading || romBusy || phase !== "offline"} onClick={() => void loadDemo()}>Use demo</button></div>
                <div className="room-step"><strong>2. Create a room</strong><span>Share a six-character code with your friend.</span></div>
                <button className="room-primary" disabled={loading || romBusy || !rom || phase !== "offline"} onClick={() => connect("create")}><Link2 size={16} /> Create room</button>
                <div className="or-separator"><span /> OR JOIN A FRIEND <span /></div>
                <label className="room-label" htmlFor="room-code">Room code</label>
                <input id="room-code" className="room-code-input" value={joinCode} maxLength={6} placeholder="ABC234" disabled={phase !== "offline"} onChange={(e) => setJoinCode(e.target.value.toUpperCase().replace(/[^A-HJ-NP-Z2-9]/g, ""))} />
                <button className="room-secondary join-button" disabled={loading || romBusy || !rom || phase !== "offline"} onClick={() => connect("join")}><Users size={16} /> Join room</button>
              </>}
            </section>
            <section className="card net-controls"><div className="section-heading"><Gamepad2 size={19} /><span>YOUR CONTROLLER</span><span className="small-counter">{player ? `P${player}` : "—"}</span></div>
              <div className="controller-body"><div className="dpad"><span className="dpad-middle" />{PAD.map(({key,bit,Icon})=><button key={key} className={`dpad-${key.toLowerCase()}`} aria-label={key} disabled={!active} {...touchProps(bit)}><Icon size={18}/></button>)}</div>
                <div className="ab-buttons"><div className="round-wrap"><button className="round-button pink" disabled={!active} {...touchProps(BUTTON_BITS.B)}>B</button><small>B</small></div><div className="round-wrap"><button className="round-button violet" disabled={!active} {...touchProps(BUTTON_BITS.A)}>A</button><small>A</small></div></div></div>
              <div className="start-select"><button disabled={!active} {...touchProps(BUTTON_BITS.SELECT)}><span className="pill-key" /> SELECT</button><button disabled={!active} {...touchProps(BUTTON_BITS.START)}><span className="pill-key" /> START</button></div>
              <p className="room-help">Arrows to move · X = A · Z = B · Enter = Start · Right Shift = Select. Standard USB/Bluetooth gamepads also work.</p>
            </section>
          </aside>
        </div>
        {error && <div className="alert error"><X size={16} /> {error}<button aria-label="Dismiss error" onClick={() => setError("")}><X size={14}/></button></div>}
        {notice && <div className="alert success"><Check size={16} /> {notice}<button aria-label="Dismiss notice" onClick={() => setNotice("")}><X size={14}/></button></div>}
        <div className="net-disclaimer"><Wifi size={15} /><span>ROM files never leave your browser. Only ROM hashes, player inputs, and state checksums are sent to the room server. Two-player games only. Both devices need the same ROM and compatible JSNES versions.</span></div>
        <footer className="footer"><span>RETRODECK / ONLINE</span><span>Frame-locked multiplayer · <Link href="/">Return to solo arcade</Link></span></footer>
      </div>
    </main>
  );
}
