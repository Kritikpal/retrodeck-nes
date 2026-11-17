# RetroDeck NES

A playable **Next.js 16 / React 19 / TypeScript** NES arcade, powered by [JSNES](https://github.com/bfirsh/jsnes).

## Quick start

Requires Node.js 20.9+.

```bash
npm install
npm run dev
```

Open **http://localhost:3000** and click **Play Demo Game**. Or load a legally obtained `.nes` ROM with the file picker or drag and drop.

To make a production build:

```bash
npm run typecheck
npm run build
npm start
```

## Included features

- **Original playable NES mini-game**: *Pixel Chase* (`public/roms/pixel-chase.nes`). Move with arrows or the touch D-pad; collect the gold star to increase your score.
- Load local `.nes` ROM files (not uploaded to any server).
- Keyboard control, USB gamepad support (through JSNES), on-screen touch controls.
- Pause, resume, reset, fullscreen, in-memory quick save/load.
- Responsive UI for desktop and mobile.
- Pauses when the tab becomes hidden.

## Design

```text
Next.js App Router (static React page)
       │
       ▼
Client-only <Arcade />  ── local ROM File/ArrayBuffer ──► JSNES Browser
       │                                              ├─ NES CPU / PPU / APU
       ├─ player controls ─► browser.nes.buttonDown()  ├─ Canvas rendering
       └─ pause/reset/save ─► browser / browser.nes    └─ Web Audio / Gamepad
```

No backend, database, or ROM hosting service is necessary. A sample ROM is served as a static file by Next.js.

## Demo ROM provenance

`public/roms/pixel-chase.nes` is generated from original code in `scripts/build_demo.py`; no proprietary game or art is included. The mini-game is created for this project and may be freely redistributed. To regenerate (requires Python + Pillow):

```bash
python scripts/build_demo.py
```

The demo ROM ships prebuilt, so Python is **not** required for running the Next.js app.

## Known limits

- JSNES does not emulate every cartridge mapper or every edge case.
- Quick save/load only lasts until you load another ROM or refresh the tab.
- Browser audio autoplay restrictions may require a click/tap to enable sound.
- Your own game ROMs must be obtained and used legally. This project does not distribute commercial Nintendo games.
