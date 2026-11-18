/** Deterministic, frame-stepped JSNES adapter. Browser's internal 60Hz scheduler is deliberately NOT used. */
export type NesInstance = {
  loadROM(data: Uint8Array): void;
  frame(): void;
  reset(): void;
  buttonDown(player: number, button: number): void;
  buttonUp(player: number, button: number): void;
  toJSON(): unknown;
};

type NesLibrary = {
  NES: new (options: {
    onFrame: (pixels: Int32Array) => void;
    onAudioSample: (left: number, right: number) => void;
    sampleRate: number;
  }) => NesInstance;
  Controller: Record<string, number>;
};

const KEY_CODES = ['BUTTON_A', 'BUTTON_B', 'BUTTON_SELECT', 'BUTTON_START', 'BUTTON_UP', 'BUTTON_DOWN', 'BUTTON_LEFT', 'BUTTON_RIGHT'];

class AudioSink {
  private context: AudioContext | null = null;
  private left: number[] = [];
  private right: number[] = [];
  private nextTime = 0;
  private sampleRate = 44100;

  unlock() {
    if (!this.context) {
      this.context = new AudioContext({ sampleRate: this.sampleRate });
      this.sampleRate = this.context.sampleRate;
    }
    void this.context.resume().catch(() => {});
  }

  sample(left: number, right: number) {
    if (!this.context || this.context.state !== 'running') return;
    this.left.push(left);
    this.right.push(right);
  }

  flush() {
    const ctx = this.context;
    if (!ctx || ctx.state !== 'running') return;
    const size = 1024;
    while (this.left.length >= size) {
      // Discard stale samples after a network stall; never queue seconds of delayed audio.
      if (this.left.length > size * 8) {
        this.left.splice(0, this.left.length - size * 2);
        this.right.splice(0, this.right.length - size * 2);
      }
      const buffer = ctx.createBuffer(2, size, ctx.sampleRate);
      buffer.getChannelData(0).set(this.left.splice(0, size));
      buffer.getChannelData(1).set(this.right.splice(0, size));
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      const at = Math.max(ctx.currentTime + 0.025, this.nextTime);
      if (at - ctx.currentTime > 0.22) { // Under heavy slowdown, prioritize current sound.
        this.nextTime = ctx.currentTime + 0.025;
        source.start(this.nextTime);
      } else source.start(at);
      this.nextTime = Math.max(ctx.currentTime + 0.025, this.nextTime) + size / ctx.sampleRate;
      source.onended = () => source.disconnect();
    }
  }

  pause() {
    this.left.length = 0; this.right.length = 0;
    this.nextTime = 0;
    if (this.context?.state === 'running') void this.context.suspend().catch(() => {});
  }

  close() {
    this.left.length = 0; this.right.length = 0;
    if (this.context) void this.context.close().catch(() => {});
    this.context = null;
  }
}

export class NetplayNes {
  private nes: NesInstance | null = null;
  private readonly audio = new AudioSink();
  private readonly ctx: CanvasRenderingContext2D;
  private readonly image: ImageData;
  private readonly buttons: number[];

  constructor(canvas: HTMLCanvasElement, lib: NesLibrary, rom: Uint8Array) {
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas 2D is not available.');
    canvas.width = 256;
    canvas.height = 240;
    ctx.imageSmoothingEnabled = false;
    this.ctx = ctx;
    this.image = ctx.createImageData(256, 240);
    this.buttons = KEY_CODES.map((key) => lib.Controller[key]);
    if (this.buttons.some((value) => value === undefined)) throw new Error('Unsupported JSNES controller version.');
    this.nes = new lib.NES({
      onFrame: (pixels) => this.draw(pixels),
      onAudioSample: (l, r) => this.audio.sample(l, r),
      sampleRate: 44100,
    });
    this.nes.loadROM(rom);
  }

  private draw(pixels: Int32Array) {
    const out = this.image.data;
    for (let i = 0, k = 0; i < pixels.length; i++, k += 4) {
      const rgb = pixels[i];
      out[k] = (rgb >> 16) & 255;
      out[k + 1] = (rgb >> 8) & 255;
      out[k + 2] = rgb & 255;
      out[k + 3] = 255;
    }
    this.ctx.putImageData(this.image, 0, 0);
  }

  unlockAudio() { this.audio.unlock(); }
  pauseAudio() { this.audio.pause(); }

  frame(p1: number, p2: number) {
    if (!this.nes) return;
    for (const [i, button] of this.buttons.entries()) {
      for (const [player, mask] of [[1, p1], [2, p2]]) {
        if (mask & (1 << i)) this.nes.buttonDown(player, button);
        else this.nes.buttonUp(player, button);
      }
    }
    this.nes.frame();
    this.audio.flush();
  }

  checksum(): string {
    if (!this.nes) return '00000000';
    // Full emulation state (CPU, RAM, PPU, mapper, and controllers), not just rendered pixels.
    const json = JSON.stringify(this.nes.toJSON());
    let hash = 2166136261;
    for (let i = 0; i < json.length; i++) {
      hash ^= json.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }

  destroy() { this.audio.close(); this.nes = null; }
}

export const BUTTON_BITS = {
  A: 1 << 0, B: 1 << 1, SELECT: 1 << 2, START: 1 << 3,
  UP: 1 << 4, DOWN: 1 << 5, LEFT: 1 << 6, RIGHT: 1 << 7,
} as const;

/** Standard browser gamepad (first connected controller, assigned to this tab's player). */
export function sampleGamepad(): number {
  if (typeof navigator === 'undefined' || !navigator.getGamepads) return 0;
  const pad = Array.from(navigator.getGamepads()).find((p) => p?.connected);
  if (!pad) return 0;
  const down = (i: number) => Boolean(pad.buttons[i]?.pressed);
  let mask = 0;
  if (down(0)) mask |= BUTTON_BITS.A;
  if (down(1) || down(2)) mask |= BUTTON_BITS.B;
  if (down(8)) mask |= BUTTON_BITS.SELECT;
  if (down(9)) mask |= BUTTON_BITS.START;
  if (down(12) || pad.axes[1] < -0.5) mask |= BUTTON_BITS.UP;
  if (down(13) || pad.axes[1] > 0.5) mask |= BUTTON_BITS.DOWN;
  if (down(14) || pad.axes[0] < -0.5) mask |= BUTTON_BITS.LEFT;
  if (down(15) || pad.axes[0] > 0.5) mask |= BUTTON_BITS.RIGHT;
  return mask;
}
