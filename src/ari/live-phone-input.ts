// A real-time input clock: GPT Live receives silence even when the trunk uses DTX.
// Queue real audio in order and never send a startup burst to the provider.
export class LivePhoneInput {
  private queue = Buffer.alloc(0);
  private timer?: ReturnType<typeof setInterval>;
  private voicedSamples = 0;
  private speechReported = false;
  private closed = false;
  private draining = false;
  private drainDone?: () => void;
  private drainPromise?: Promise<void>;

  constructor(
    private readonly send: (audio: Buffer) => void,
    private readonly onSpeech: () => void,
    private readonly onFailure: () => void,
  ) {}

  enqueue(audio: Buffer): void {
    if (this.closed || this.draining) return;
    if (this.queue.length + audio.length > 80_000) {
      this.onFailure();
      return;
    }
    this.queue = Buffer.concat([this.queue, audio]);
  }

  start(): void {
    if (this.closed || this.timer) return;
    this.timer = setInterval(() => this.tick(), 20);
    this.timer.unref();
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.queue = Buffer.alloc(0);
    this.drainDone?.();
  }

  drain(): Promise<void> {
    if (this.drainPromise) return this.drainPromise;
    if (this.closed || !this.queue.length) {
      this.close();
      return Promise.resolve();
    }
    this.draining = true;
    this.drainPromise = new Promise<void>((resolve) => {
      this.drainDone = resolve;
    });
    this.start();
    return this.drainPromise;
  }

  private tick(): void {
    if (this.closed) return;
    const frame = Buffer.alloc(160, 0xff); // 20 ms, 8 kHz G.711 mu-law silence.
    const count = Math.min(160, this.queue.length);
    this.queue.copy(frame, 0, 0, count);
    this.queue = this.queue.subarray(count);
    if (!this.draining && !this.speechReported) {
      let energy = 0;
      for (const byte of frame) {
        const value = ~byte & 255;
        const magnitude = (((value & 15) << 3) + 132) << ((value >> 4) & 7);
        const sample = magnitude - 132;
        energy += sample * sample;
      }
      this.voicedSamples =
        Math.sqrt(energy / 160) >= 600 ? this.voicedSamples + 160 : 0;
      if (this.voicedSamples >= 640) {
        this.speechReported = true;
        this.onSpeech();
      }
    }
    if (!this.closed) this.send(frame);
    if (this.draining && !this.queue.length) this.close();
  }
}
