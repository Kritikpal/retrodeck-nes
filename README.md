# RetroDeck NES — browser arcade with online 2-player rooms

Next.js 16, React 19, TypeScript, JSNES 2, and a small persistent Node.js WebSocket relay. Play the included Pixel Chase Duo game online with a friend using only a room code. No account, game selection, ROM upload, database, or external realtime service required for the multiplayer MVP. The separate solo arcade still supports local ROM loading.

## Run locally

Requires **Node.js 20.9+**. Clone this repository and run:

```bash
npm install
npm run dev
```

Open http://localhost:3000 for solo play, or http://localhost:3000/multiplayer for online play.

`npm run dev` starts two processes:

- Next.js HTTP server on **port 3000**.
- Persistent WebSocket relay on **port 3001**.

## Play a two-player game (no ROM upload)

1. Open **/multiplayer** in two browser windows or on two devices. The bundled **Pixel Chase Duo** game loads automatically on both devices.
2. Player 1 clicks **Create room**. Share the six-character room code using **Copy room code**.
3. Player 2 enters the code and clicks **Join room**.
4. The game starts for both players automatically once the room has two players.
5. Use arrows, X/Z, Enter, Right Shift, on-screen touch buttons, or a standard gamepad. Each browser controls **only its assigned player**.
6. Pause and reset are synchronized. Hiding a browser tab pauses the room.

**Only Pixel Chase Duo is available in multiplayer.** There is no multiplayer ROM picker, file input, or server-side game upload. The separate solo arcade remains unchanged.

## Architecture

```text
Player 1: Next.js + JSNES       Player 2: Next.js + JSNES
       | controller masks                | controller masks
       +---------------+-----------------+
                       v
        Node.js room relay (WebSockets)
        - room codes / pairing (one bundled demo game)
        - buffers input per emulated frame
        - broadcasts a frame only after BOTH inputs arrive
                       |
       +---------------+-----------------+
       v                                 v
Each emulator applies P1 + P2 inputs to the SAME frame number
and advances its own CPU/PPU/APU once; frames drawn on local canvas.
```

**Deterministic lockstep:** Input for eight upcoming frames is queued ahead (~133 ms at 60Hz) to absorb network latency. A local game can advance only after both controller masks have arrived for the next numbered frame. This trades input latency and occasional stalls for synchronized results. Every 300 frames, clients exchange **checksums** of emulator state via the relay; mismatches pause the session and require a synchronized reset. This is an MVP, not latency-compensated rollback netcode. It is best for stable, reasonably low-latency connections; high latency or jitter can stall play.

No ROM bytes, rendered frames, or audio are sent across WebSockets: only room messages, controller input masks, frame numbers, and state checksums. Both browsers load the same bundled demo from their web server.

## Deploy on a VPS / persistent Node host

```bash
npm install
npm run build
npm start
```

Use a platform that allows **persistent WebSocket connections**, such as a VM or Node.js service. **A Next.js-only serverless deployment (e.g. just Vercel) is not sufficient for the room relay.**

For HTTPS production, terminate TLS on a reverse proxy and forward `/ws` WebSocket upgrades to `127.0.0.1:3001`. Set:

```bash
# The exact browser origin(s) allowed to establish WebSockets
ROOM_ALLOWED_ORIGINS=https://arcade.example.com
# URL seen from the browser; reverse proxy forwards to localhost:3001
NEXT_PUBLIC_WS_URL=wss://arcade.example.com/ws
# Optional defaults
WS_PORT=3001
WS_HOST=0.0.0.0
```

The frontend build embeds `NEXT_PUBLIC_WS_URL`, so set it **before `npm run build`**. The relay's default allowed origins are `http://localhost:3000,http://127.0.0.1:3000`. For LAN testing, add your LAN origin (e.g. `http://192.168.1.50:3000`) to `ROOM_ALLOWED_ORIGINS` and access the app via that address. HTTPS is recommended for real deployments; users on another device need network access to both the web app and the WebSocket relay.

The room relay is in-memory, scoped to **one** Node.js process: room state does not survive server restarts or load balancing. Use sticky sessions or a shared coordination layer if scaling across multiple instances.

## Files

- `components/Arcade.tsx` — existing solo emulator UI, unchanged functionality.
- `components/MultiplayerArcade.tsx` — auto-loaded Pixel Chase Duo, room code, and controller UI (no upload picker).
- `lib/nes-netplay.ts` — low-level JSNES with local canvas/audio rendering and explicit `frame()` stepping.
- `server/rooms.mjs` — room logic, ordered lockstep input queues, checksums, resets, lifecycle.
- `server/index.mjs` — WebSocket relay with origin validation, heartbeat, input validation and rate-limiting.
- `scripts/run.mjs` — starts Next.js and WebSocket processes.
- `scripts/build_demo.py` — builds the original single-player ROM.
- `scripts/build_duo.py` — builds the original two-player ROM (requires Python + Pillow to regenerate; not needed to run).
- `tests/rooms.test.mjs` — automated room/protocol tests.

## Validation

```bash
npm run test        # Node.js room protocol tests
npm run typecheck   # TypeScript check
npm run build       # Next.js production build
```

## MVP limitations / security

- Only the original, freely redistributable Pixel Chase Duo is available in multiplayer. No proprietary ROMs are included.
- Only two simultaneous players per room. A disconnected guest can rejoin; the match then restarts from frame zero. If the host leaves, the room closes. Rooms expire after 30 minutes without activity.
- Room codes provide invitation-based access, **not strong authentication**. No accounts, lobby chat, spectators, matchmaking, save-state resume, anti-cheat protection or guaranteed fair play.
- The browser must remain responsive; hiding a tab pauses both peers.
- Both peers should load the web app from the same deployment so they run the same Pixel Chase Duo ROM and JSNES version.
- Server checksums detect divergence, but automatic snapshot repair, latency prediction and rollback are not implemented.
- No networked ROM file sharing: both browsers fetch the bundled Pixel Chase Duo ROM automatically.

This repository ships original, freely redistributable homebrew ROMs and contains no commercial Nintendo games.
