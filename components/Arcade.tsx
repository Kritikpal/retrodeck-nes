"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ChangeEvent, DragEvent, PointerEvent } from "react";
import {
  ArrowDown, ArrowLeft, ArrowRight, ArrowUp,
  Check, CircleHelp, CloudUpload, Expand, Gamepad2, HardDriveUpload,
  Keyboard, Maximize2, MonitorPlay, Pause, Play, RotateCcw,
  Save, Upload, X, Zap,
} from "lucide-react";

type Emulator = {
  start(): void;
  stop(): void;
  destroy(): void;
  loadROM(data: Uint8Array): void;
  nes: {
    buttonDown(player: number, button: number): void;
    buttonUp(player: number, button: number): void;
    reset(): void;
    toJSON(): unknown;
    fromJSON(state: unknown): void;
  };
};
type EmulatorModule = {
  Browser: new (options: { container: HTMLElement; onError?: (error: unknown) => void }) => Emulator;
  Controller: Record<string, number>;
};

type GameInfo = { name: string; size: number; source: "Demo cartridge" | "Your ROM" };
const MAX_ROM_SIZE = 10 * 1024 * 1024;
const buttons = [
  { label: "B", code: "BUTTON_B", skin: "pink" },
  { label: "A", code: "BUTTON_A", skin: "violet" },
];

function formatSize(bytes: number) {
  return bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isNesRom(bytes: Uint8Array) {
  return bytes.length >= 16 && bytes[0] === 0x4e && bytes[1] === 0x45 && bytes[2] === 0x53 && bytes[3] === 0x1a;
}

export function Arcade() {
  const mountRef = useRef<HTMLDivElement>(null);
  const screenRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const emulatorRef = useRef<Emulator | null>(null);
  const moduleRef = useRef<EmulatorModule | null>(null);
  const saveRef = useRef<{ gameKey: string; state: unknown } | null>(null);
  const gameKeyRef = useRef("");
  const activeButtonsRef = useRef(new Set<string>());
  const [ready, setReady] = useState(false);
  const [game, setGame] = useState<GameInfo | null>(null);
  const [paused, setPaused] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [hasSave, setHasSave] = useState(false);
  const [showHelp, setShowHelp] = useState(false);

  useEffect(() => {
    let canceled = false;
    async function init() {
      try {
        const jsnes = (await import("jsnes")) as unknown as EmulatorModule;
        if (canceled || !mountRef.current) return;
        moduleRef.current = jsnes;
        emulatorRef.current = new jsnes.Browser({
          container: mountRef.current,
          onError: (cause) => {
            setError(`Emulator error: ${String(cause)}`);
            setPaused(true);
          },
        });
        setReady(true);
      } catch (cause) {
        if (!canceled) setError(`Cannot initialize NES emulator: ${String(cause)}`);
      }
    }
    void init();
    return () => {
      canceled = true;
      emulatorRef.current?.destroy();
      emulatorRef.current = null;
    };
  }, []);

  // Stop emulation when the page is backgrounded so it doesn't waste CPU.
  useEffect(() => {
    function onVisibilityChange() {
      if (document.hidden && gameKeyRef.current) {
        emulatorRef.current?.stop();
        setPaused(true);
      }
    }
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);

  const releaseAllButtons = useCallback(() => {
    const nes = emulatorRef.current?.nes;
    const controller = moduleRef.current?.Controller;
    if (nes && controller) {
      activeButtonsRef.current.forEach((key) => nes.buttonUp(1, controller[key]));
    }
    activeButtonsRef.current.clear();
  }, []);

  const activateROM = useCallback((bytes: Uint8Array, info: GameInfo) => {
    if (!emulatorRef.current) throw new Error("Emulator is still starting. Try again.");
    if (!isNesRom(bytes)) throw new Error("Not a valid iNES .nes cartridge file.");
    releaseAllButtons();
    // Stop the previous game before inserting the next cartridge.
    emulatorRef.current.stop();
    emulatorRef.current.loadROM(bytes);
    gameKeyRef.current = `${info.name}:${info.size}`;
    saveRef.current = null;
    setHasSave(false);
    setGame(info);
    setPaused(false);
    setError("");
    setNotice(`${info.name} loaded — enjoy!`);
    window.setTimeout(() => setNotice(""), 3500);
  }, [releaseAllButtons]);

  const playDemo = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/roms/pixel-chase.nes");
      if (!response.ok) throw new Error("Could not load the bundled demo ROM.");
      const bytes = new Uint8Array(await response.arrayBuffer());
      activateROM(bytes, { name: "Pixel Chase", size: bytes.length, source: "Demo cartridge" });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to load demo.");
    } finally {
      setBusy(false);
    }
  }, [activateROM]);

  const openRom = useCallback(async (file?: File) => {
    if (!file) return;
    setBusy(true);
    setError("");
    try {
      if (file.size > MAX_ROM_SIZE) throw new Error("ROM is too large (10 MB maximum).");
      if (file.size < 16) throw new Error("This file is too small to be an NES cartridge.");
      const bytes = new Uint8Array(await file.arrayBuffer());
      activateROM(bytes, {
        name: file.name.replace(/\.nes$/i, ""),
        size: bytes.length,
        source: "Your ROM",
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load ROM.");
    } finally {
      setBusy(false);
    }
  }, [activateROM]);

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    void openRom(event.target.files?.[0]);
    event.target.value = "";
  };
  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    void openRom(event.dataTransfer.files[0]);
  };

  const togglePause = () => {
    if (!game || !emulatorRef.current) return;
    releaseAllButtons();
    if (paused) emulatorRef.current.start();
    else emulatorRef.current.stop();
    setPaused(!paused);
  };
  const resetGame = () => {
    if (!game || !emulatorRef.current) return;
    releaseAllButtons();
    emulatorRef.current.nes.reset();
    if (paused) emulatorRef.current.start();
    setPaused(false);
    setNotice("Console reset");
  };
  const saveGame = () => {
    if (!game || !emulatorRef.current) return;
    try {
      saveRef.current = { gameKey: gameKeyRef.current, state: emulatorRef.current.nes.toJSON() };
      setHasSave(true);
      setNotice("Quick save created for this session");
      setError("");
    } catch {
      setError("Save state is not supported by this cartridge.");
    }
  };
  const loadGame = () => {
    if (!game || !emulatorRef.current || saveRef.current?.gameKey !== gameKeyRef.current) return;
    try {
      releaseAllButtons();
      emulatorRef.current.nes.fromJSON(saveRef.current.state);
      if (paused) emulatorRef.current.start();
      setPaused(false);
      setNotice("Quick save restored");
      setError("");
    } catch {
      setError("Unable to restore this save state.");
    }
  };
  const fullscreen = () => {
    if (screenRef.current?.requestFullscreen) void screenRef.current.requestFullscreen();
  };

  const pressButton = (code: string, event: PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    if (!game || paused || activeButtonsRef.current.has(code)) return;
    const key = moduleRef.current?.Controller[code];
    if (key === undefined) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    emulatorRef.current?.nes.buttonDown(1, key);
    activeButtonsRef.current.add(code);
  };
  const releaseButton = (code: string) => {
    if (!activeButtonsRef.current.has(code)) return;
    const key = moduleRef.current?.Controller[code];
    if (key !== undefined) emulatorRef.current?.nes.buttonUp(1, key);
    activeButtonsRef.current.delete(code);
  };
  const controlEvents = (code: string) => ({
    onPointerDown: (event: PointerEvent<HTMLButtonElement>) => pressButton(code, event),
    onPointerUp: () => releaseButton(code),
    onPointerCancel: () => releaseButton(code),
    onLostPointerCapture: () => releaseButton(code),
  });

  return (
    <main className="shell">
      <input ref={fileRef} type="file" accept=".nes,application/octet-stream" hidden onChange={handleFileChange} aria-label="Choose NES ROM" />
      <header className="topbar">
        <div className="brand">
          <div className="brand-symbol"><Gamepad2 size={23} strokeWidth={2.4} /></div>
          <span className="brand-text">RETRO<span>DECK</span><small> / NES</small></span>
        </div>
        <nav className="topnav"><span className="nav-active">THE ARCADE</span><span className="nav-secondary">8-BIT COLLECTION</span></nav>
        <button className="icon-top" title="Controls and help" aria-label="Help" onClick={() => setShowHelp(true)}><CircleHelp size={19} /></button>
      </header>

      <div className="content">
        <div className="intro"><div><div className="eyebrow"><span className="signal" /> YOUR PERSONAL RETRO ARCADE <span className="intro-line" /></div>
          <h1>Old school games.<br /><em>New school playground.</em></h1>
          <p>Drop in a cartridge. Press start. Get lost in the pixels.</p></div>
          <div className="intro-corner"><div className="tiny-label">SYSTEM ONLINE</div><div className="system-id">NES-001 <span>●</span></div><div className="tiny-note">256 × 240 · 60 FPS TARGET</div></div>
        </div>

        <div className="main-grid">
          <section className="console-panel" aria-label="NES game console">
            <div className="console-heading"><div className="heading-left"><span className="console-status-dot" /> <span>GAME CONSOLE</span><span className="console-divider">/</span><span className="heading-muted">PLAYER 01</span></div><div className="power-status"><span className={`power-light ${game && !paused ? "on" : ""}`} /> {game ? paused ? "PAUSED" : "POWER ON" : "STANDBY"}</div></div>
            <div ref={screenRef} className="tv-housing">
              <div className="screen-corner top-left" /><div className="screen-corner top-right" /><div className="screen-corner bottom-left" /><div className="screen-corner bottom-right" />
              <div className="display-bezel">
                <div ref={mountRef} className={`emulator-canvas ${game ? "playing" : ""}`} aria-label="NES game display" />
                {!game && <div className="empty-display">
                  <div className="pixels-icon"><span /><span /><span /><span /><span /><span /><span /><span /><span /></div>
                  <div className="empty-title">INSERT CARTRIDGE</div><div className="empty-sub">NO GAME LOADED</div>
                  <button className="screen-play" disabled={!ready || busy} onClick={() => void playDemo()}><Play size={14} fill="currentColor" /> {ready ? "PLAY DEMO GAME" : "BOOTING..."}</button>
                </div>}
                {game && paused && <div className="paused-overlay"><Pause size={26} fill="currentColor" /><span>GAME PAUSED</span><button onClick={togglePause}>RESUME GAME</button></div>}
                <div className="scanlines" aria-hidden="true" />
              </div>
              <span className="screen-serial">RD-1985 / SYSTEM 01</span><span className="screen-logo">RETROVISION™</span>
              <button className="fullscreen" onClick={fullscreen} title="Full screen" aria-label="Full screen"><Maximize2 size={15} /></button>
            </div>

            <div className="game-bottom">
              <div className="now-playing"><div className="np-icon"><MonitorPlay size={20} /></div><div><small>NOW PLAYING</small><strong>{game?.name ?? "No cartridge loaded"}</strong><span>{game ? `${game.source} · ${formatSize(game.size)}` : "Choose a game to get started"}</span></div></div>
              <div className="game-actions"><button className="game-action" disabled={!game} onClick={togglePause} title={paused ? "Resume" : "Pause"}>{paused ? <Play size={17} /> : <Pause size={17} />}</button><button className="game-action" disabled={!game} onClick={resetGame} title="Reset game"><RotateCcw size={17} /></button><button className="game-action" disabled={!game} onClick={saveGame} title="Quick save"><Save size={17} /></button><button className="game-action" disabled={!hasSave || !game} onClick={loadGame} title="Load quick save"><Upload size={17} /></button></div>
            </div>
          </section>

          <aside className="side-panel">
            <section className="card load-panel"><div className="section-heading"><div className="section-heading-icon"><HardDriveUpload size={17} /></div><span>YOUR CARTRIDGES</span><span className="small-counter">01 / ∞</span></div>
              <div className={`dropzone ${dragging ? "dragging" : ""}`} onDragOver={(e) => { e.preventDefault(); setDragging(true); }} onDragLeave={(e) => { e.preventDefault(); setDragging(false); }} onDrop={handleDrop}>
                <div className="drop-icon"><CloudUpload size={28} /></div><strong>Drop your ROM here</strong><p>or browse files to load a game</p><button disabled={!ready || busy} onClick={() => fileRef.current?.click()} className="browse-button"><Upload size={14} /> BROWSE .NES FILES</button><small>.NES FORMAT · MAX 10 MB</small>
              </div>
              <div className="or-separator"><span /> OR TRY A GAME <span /></div>
              <button disabled={!ready || busy} className="demo-card" onClick={() => void playDemo()}><div className="demo-art"><div className="star-shape">✦</div></div><div className="demo-copy"><strong>Pixel Chase</strong><span>Original NES homebrew</span><small><span className="green-dot" /> FREE DEMO INCLUDED</small></div><Play size={18} className="demo-play" fill="currentColor" /></button>
            </section>

            <section className="card controller-panel"><div className="section-heading"><div className="section-heading-icon"><Gamepad2 size={18} /></div><span>CONTROLLER</span><span className="small-counter">P1</span></div>
              <div className="controller-description">The real deal, right on your screen.</div>
              <div className="controller-body">
                <div className="dpad" aria-label="Directional pad">
                  <span className="dpad-middle" />
                  {([ ["up", "BUTTON_UP", ArrowUp], ["left", "BUTTON_LEFT", ArrowLeft], ["right", "BUTTON_RIGHT", ArrowRight], ["down", "BUTTON_DOWN", ArrowDown] ] as const).map(([side, code, Icon]) => <button key={code} disabled={!game || paused} className={`dpad-${side}`} aria-label={side} {...controlEvents(code)}><Icon size={18} /></button>)}
                </div>
                <div className="ab-buttons">{buttons.map((b) => <div className="round-wrap" key={b.code}><button disabled={!game || paused} className={`round-button ${b.skin}`} aria-label={`NES ${b.label}`} {...controlEvents(b.code)}>{b.label}</button><small>{b.label}</small></div>)}</div>
              </div>
              <div className="start-select"><button disabled={!game || paused} {...controlEvents("BUTTON_SELECT")}><span className="pill-key" /> SELECT</button><button disabled={!game || paused} {...controlEvents("BUTTON_START")}><span className="pill-key" /> START</button></div>
              <div className="keyboard-note"><Keyboard size={15} /><span><strong>KEYBOARD</strong> Arrow keys · Z / X · Enter</span></div>
            </section>
          </aside>
        </div>

        {error && <div className="alert error"><X size={17} /> {error}<button onClick={() => setError("")} aria-label="Dismiss error"><X size={14} /></button></div>}
        {notice && <div className="alert success"><Check size={17} /> {notice}<button onClick={() => setNotice("")} aria-label="Dismiss message"><X size={14} /></button></div>}

        <footer className="footer"><span><Zap size={14} /> PURE 8-BIT ENERGY</span><div>Built for the nostalgia. Powered by <a href="https://github.com/bfirsh/jsnes" target="_blank" rel="noreferrer">JSNES</a>. Your ROMs stay in your browser.</div><span>© RETRODECK 2026</span></footer>
      </div>
      {showHelp && <div className="modal-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) setShowHelp(false); }}><div className="help-modal" role="dialog" aria-modal="true" aria-labelledby="help-title"><button className="modal-close" aria-label="Close" onClick={() => setShowHelp(false)}><X size={19} /></button><div className="modal-icon"><Gamepad2 /></div><h2 id="help-title">How to play</h2><p>Start the original Pixel Chase demo, or upload an iNES-format <code>.nes</code> ROM you have the right to use.</p><div className="help-rows"><div><span>Move</span><strong>Arrow keys / D-pad</strong></div><div><span>Button A</span><strong>X</strong></div><div><span>Button B</span><strong>Z</strong></div><div><span>Start</span><strong>Enter</strong></div><div><span>Select</span><strong>Right Ctrl</strong></div><div><span>Save/load</span><strong>Session-only quick state</strong></div></div><p className="help-small">USB controllers supported through JSNES gamepad support when the browser permits it. Audio may require interacting with the page first. ROMs are processed locally and are not uploaded to a server.</p><button className="modal-done" onClick={() => setShowHelp(false)}>GOT IT <ArrowRight size={15} /></button></div></div>}
    </main>
  );
}
