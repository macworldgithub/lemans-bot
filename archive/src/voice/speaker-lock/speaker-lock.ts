import { cosineSimilarity, SpeakerVerifier } from './speaker-verifier.service';

export type SpeakerDecision = 'accepted' | 'rejected';
export type SpeakerReason =
  | 'enrolling' // voiceprint not built yet: first speaker is the caller
  | 'match'
  | 'other-speaker'
  | 'too-short' // too little audio to judge reliably, let it through
  | 'unavailable'; // verifier failed: fail open

export interface SpeakerVerdict {
  decision: SpeakerDecision;
  reason: SpeakerReason;
  score: number | null;
  threshold: number | null;
  durationSec: number;
}

export interface SpeakerLockOptions {
  /** Similarity needed for turns of at least fullVerifySec. */
  threshold: number;
  /** Similarity needed at minVerifySec; scales linearly up to `threshold`. */
  shortThreshold: number;
  /** Turns shorter than this are accepted without a check. */
  minVerifySec: number;
  fullVerifySec: number;
  /** Speech needed before a barge-in is verified and the bot is cut off. */
  bargeInMs: number;
  /** Caller speech needed before the lock engages. */
  lockAfterSec: number;
  maxEnrollSec: number;
  maxVerifySec: number;
}

export const DEFAULT_SPEAKER_LOCK_OPTIONS: SpeakerLockOptions = {
  threshold: 0.4,
  shortThreshold: 0.22,
  minVerifySec: 0.6,
  fullVerifySec: 1.5,
  bargeInMs: 800,
  lockAfterSec: 1.5,
  maxEnrollSec: 8,
  maxVerifySec: 4,
};

// 8 kHz phone audio narrows the gap between voices, so phone calls need a
// stricter match (from evaluation on real English speakers).
export const PHONE_SPEAKER_LOCK_THRESHOLDS = {
  threshold: 0.5,
  shortThreshold: 0.32,
};

export function speakerLockOptionsFromEnv(
  get: (key: string) => string | undefined,
  channel: 'web' | 'phone' = 'web',
): SpeakerLockOptions {
  const num = (key: string, fallback: number) => {
    const v = Number(get(key));
    return get(key) !== undefined && Number.isFinite(v) ? v : fallback;
  };
  const d = DEFAULT_SPEAKER_LOCK_OPTIONS;
  const phone = channel === 'phone';
  const p = PHONE_SPEAKER_LOCK_THRESHOLDS;
  return {
    threshold: phone
      ? num('SPEAKER_LOCK_PHONE_THRESHOLD', p.threshold)
      : num('SPEAKER_LOCK_THRESHOLD', d.threshold),
    shortThreshold: phone
      ? num('SPEAKER_LOCK_PHONE_SHORT_THRESHOLD', p.shortThreshold)
      : num('SPEAKER_LOCK_SHORT_THRESHOLD', d.shortThreshold),
    minVerifySec: num('SPEAKER_LOCK_MIN_VERIFY_SEC', d.minVerifySec),
    fullVerifySec: d.fullVerifySec,
    bargeInMs: num('SPEAKER_LOCK_BARGE_IN_MS', d.bargeInMs),
    lockAfterSec: num('SPEAKER_LOCK_ENROLL_SEC', d.lockAfterSec),
    maxEnrollSec: d.maxEnrollSec,
    maxVerifySec: d.maxVerifySec,
  };
}

/** Fields of OpenAI Realtime server events the lock reads. */
export interface RealtimeServerEvent {
  type?: string;
  item_id?: string;
  audio_start_ms?: number;
  audio_end_ms?: number;
}

export interface SpeakerLockHooks {
  /** Send a client event to the OpenAI Realtime socket. */
  send(event: Record<string, unknown>): void;
  isResponseActive(): boolean;
  /** Verified caller started talking over the bot: stop bot audio now. */
  onBargeIn(itemId: string): void;
  onVerdict(itemId: string, verdict: SpeakerVerdict): void;
  log?(message: string): void;
}

interface Turn {
  itemId: string;
  startMs: number;
  endMs: number | null;
  early: 'pending' | 'checking' | 'done';
  bargedIn: boolean;
}

const SR = 16000;
const RING_SEC = 30;
const IGNORED_DELETE_TIMEOUT_MS = 4000;

/**
 * Streaming linear resampler to 16 kHz that keeps its phase across chunks,
 * so the sample clock stays aligned with OpenAI's audio_start_ms/audio_end_ms.
 */
export class StreamResampler {
  private pos = 0;
  private prev = 0;
  private readonly step: number;

  constructor(fromRate: number, toRate = SR) {
    this.step = fromRate / toRate;
  }

  process(x: Float32Array): Float32Array {
    if (this.step === 1) return x;
    const out = new Float32Array(Math.ceil((x.length + 1) / this.step) + 1);
    let n = 0;
    while (this.pos < x.length - 1) {
      const j = Math.floor(this.pos);
      const t = this.pos - j;
      const a = j < 0 ? this.prev : x[j];
      out[n++] = a + (x[j + 1] - a) * t;
      this.pos += this.step;
    }
    if (x.length) {
      this.pos -= x.length;
      this.prev = x[x.length - 1];
    }
    return out.subarray(0, n);
  }
}

export function pcm16ToFloat(buf: Buffer): Float32Array {
  const n = buf.length >> 1;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(i * 2) / 32768;
  return out;
}

const ULAW_TABLE = (() => {
  const t = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const u = ~i & 0xff;
    const sign = u & 0x80;
    const exponent = (u >> 4) & 0x07;
    const mantissa = u & 0x0f;
    let sample = (((mantissa << 3) + 0x84) << exponent) - 0x84;
    if (sign) sample = -sample;
    t[i] = sample / 32768;
  }
  return t;
})();

export function ulawToFloat(buf: Buffer): Float32Array {
  const out = new Float32Array(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = ULAW_TABLE[buf[i]];
  return out;
}

/**
 * Per-call speaker lock on top of OpenAI server VAD.
 *
 * The session runs with create_response=false / interrupt_response=false, so
 * OpenAI still detects and transcribes turns but never answers on its own.
 * Each committed turn is scored against the caller's voiceprint (built from
 * their first ~1.5 s of speech): a match triggers response.create, anything
 * else is deleted from the conversation so the model never sees it.
 */
export class SpeakerLock {
  private readonly ring = new Float32Array(SR * RING_SEC);
  private written = 0; // absolute 16 kHz samples received
  private readonly resamplers = new Map<number, StreamResampler>();

  private readonly turns = new Map<string, Turn>();
  private enrollChunks: Float32Array[] = [];
  private enrollSec = 0;
  private voiceprint: Float32Array | null = null;
  private enrollGen = 0;

  private pendingResponse = false;
  private readonly ignored = new Map<string, ReturnType<typeof setTimeout>>();
  private closed = false;

  constructor(
    private readonly verifier: SpeakerVerifier,
    private readonly hooks: SpeakerLockHooks,
    private readonly opts: SpeakerLockOptions = DEFAULT_SPEAKER_LOCK_OPTIONS,
  ) {}

  get locked(): boolean {
    return this.voiceprint !== null;
  }

  // ─── Audio in (exactly what is appended to OpenAI) ─────────────────────────

  pushPcm16(buf: Buffer, sampleRate: number): void {
    this.pushFloat(pcm16ToFloat(buf), sampleRate);
  }

  pushUlaw(buf: Buffer): void {
    this.pushFloat(ulawToFloat(buf), 8000);
  }

  pushFloat(samples: Float32Array, sampleRate: number): void {
    let rs = this.resamplers.get(sampleRate);
    if (!rs) {
      rs = new StreamResampler(sampleRate);
      this.resamplers.set(sampleRate, rs);
    }
    const x = rs.process(samples);
    for (let i = 0; i < x.length; i++) {
      this.ring[(this.written + i) % this.ring.length] = x[i];
    }
    this.written += x.length;
    this.maybeEarlyCheck();
  }

  // ─── OpenAI server events ──────────────────────────────────────────────────

  handleEvent(event: RealtimeServerEvent): void {
    if (this.closed) return;
    const itemId = event.item_id ?? '';
    switch (event.type) {
      case 'input_audio_buffer.speech_started':
        this.onSpeechStarted(itemId, event.audio_start_ms ?? this.nowMs());
        break;
      case 'input_audio_buffer.speech_stopped': {
        const turn = this.turns.get(itemId);
        if (turn) turn.endMs = event.audio_end_ms ?? this.nowMs();
        break;
      }
      case 'input_audio_buffer.committed':
        void this.onCommitted(itemId);
        break;
      case 'conversation.item.input_audio_transcription.completed':
      case 'conversation.item.input_audio_transcription.failed':
        // Ignored turns are kept until transcribed so the monitor can show
        // what the other voice said, then removed from the conversation.
        if (this.ignored.has(itemId)) this.deleteIgnored(itemId);
        break;
      case 'response.done':
        if (this.pendingResponse) {
          this.pendingResponse = false;
          this.hooks.send({ type: 'response.create' });
        }
        break;
    }
  }

  close(): void {
    this.closed = true;
    for (const t of this.ignored.values()) clearTimeout(t);
    this.ignored.clear();
    this.turns.clear();
  }

  // ─── Turn handling ─────────────────────────────────────────────────────────

  private onSpeechStarted(itemId: string, startMs: number): void {
    if (!itemId) return;
    const turn: Turn = {
      itemId,
      startMs,
      endMs: null,
      early: 'pending',
      bargedIn: false,
    };
    this.turns.set(itemId, turn);
    // Before the voiceprint exists everyone is "the caller": keep the
    // original instant barge-in.
    if (!this.locked || !this.verifier.ready) this.bargeIn(turn);
  }

  private maybeEarlyCheck(): void {
    if (!this.locked || !this.verifier.ready) return;
    for (const turn of this.turns.values()) {
      if (turn.early !== 'pending' || turn.endMs !== null) continue;
      if (this.nowMs() - turn.startMs < this.opts.bargeInMs) continue;
      turn.early = 'checking';
      const audio = this.slice(turn.startMs, this.nowMs());
      void this.score(audio)
        .then((score) => {
          const sec = audio.length / SR;
          // Turn already committed: the full-turn verdict decides instead.
          if (!this.turns.has(turn.itemId)) return;
          if (score >= this.thresholdFor(sec)) this.bargeIn(turn);
          this.hooks.log?.(
            `early check ${turn.itemId} ${sec.toFixed(1)}s score=${score.toFixed(2)}`,
          );
        })
        .catch(() => undefined)
        .finally(() => (turn.early = 'done'));
    }
  }

  private async onCommitted(itemId: string): Promise<void> {
    const turn = this.turns.get(itemId);
    if (!turn) return;
    this.turns.delete(itemId);
    turn.early = 'done';

    const endMs = turn.endMs ?? this.nowMs();
    const audio = this.slice(turn.startMs, endMs);
    const durationSec = audio.length / SR;
    const decideStart = Date.now();
    const verdict = await this.decide(audio, durationSec);
    const decideMs = Date.now() - decideStart;
    if (this.closed) return;

    if (verdict.decision === 'accepted') {
      this.bargeIn(turn);
      this.flushIgnored();
      this.requestResponse();
    } else {
      this.ignored.set(
        itemId,
        setTimeout(() => this.deleteIgnored(itemId), IGNORED_DELETE_TIMEOUT_MS),
      );
    }
    this.hooks.log?.(
      `${itemId} ${verdict.decision} (${verdict.reason}) ${durationSec.toFixed(1)}s score=${verdict.score?.toFixed(2) ?? '-'} in ${decideMs}ms`,
    );
    this.hooks.onVerdict(itemId, verdict);
  }

  private async decide(
    audio: Float32Array,
    durationSec: number,
  ): Promise<SpeakerVerdict> {
    const base = { durationSec: round(durationSec) };
    if (!this.verifier.ready) {
      return {
        ...base,
        decision: 'accepted',
        reason: 'unavailable',
        score: null,
        threshold: null,
      };
    }
    if (!this.locked) {
      // Voiceprint is built off the response path: the reply never waits on it.
      void this.enroll(audio);
      return {
        ...base,
        decision: 'accepted',
        reason: 'enrolling',
        score: null,
        threshold: null,
      };
    }
    if (durationSec < this.opts.minVerifySec) {
      return {
        ...base,
        decision: 'accepted',
        reason: 'too-short',
        score: null,
        threshold: null,
      };
    }
    let score: number;
    try {
      score = await this.score(audio);
    } catch {
      return {
        ...base,
        decision: 'accepted',
        reason: 'unavailable',
        score: null,
        threshold: null,
      };
    }
    const threshold = this.thresholdFor(durationSec);
    const ok = score >= threshold;
    // Confident matches refine the voiceprint (more phonetic coverage).
    if (ok && score >= this.opts.threshold) void this.enroll(audio);
    return {
      ...base,
      decision: ok ? 'accepted' : 'rejected',
      reason: ok ? 'match' : 'other-speaker',
      score: round(score),
      threshold: round(threshold),
    };
  }

  private async enroll(audio: Float32Array): Promise<void> {
    if (this.enrollSec >= this.opts.maxEnrollSec || audio.length < SR * 0.3)
      return;
    const room = Math.floor((this.opts.maxEnrollSec - this.enrollSec) * SR);
    const chunk = audio.subarray(0, room);
    this.enrollChunks.push(Float32Array.from(chunk));
    this.enrollSec += chunk.length / SR;
    if (this.enrollSec < this.opts.lockAfterSec) return;
    const gen = ++this.enrollGen;
    try {
      const all = concat(this.enrollChunks);
      const wasLocked = this.locked;
      const voiceprint = await this.verifier.embed(all);
      if (gen !== this.enrollGen) return; // a newer voiceprint is on its way
      this.voiceprint = voiceprint;
      if (!wasLocked) {
        this.hooks.log?.(
          `voice locked on ${this.enrollSec.toFixed(1)}s of caller speech`,
        );
      }
    } catch {
      // keep previous voiceprint
    }
  }

  private async score(audio: Float32Array): Promise<number> {
    const max = Math.floor(this.opts.maxVerifySec * SR);
    const clip = audio.length > max ? audio.subarray(0, max) : audio;
    const emb = await this.verifier.embed(clip);
    return cosineSimilarity(this.voiceprint!, emb);
  }

  private thresholdFor(sec: number): number {
    const {
      minVerifySec: lo,
      fullVerifySec: hi,
      shortThreshold,
      threshold,
    } = this.opts;
    if (sec >= hi) return threshold;
    const t = Math.max(0, (sec - lo) / (hi - lo));
    return shortThreshold + (threshold - shortThreshold) * t;
  }

  // ─── Response control ─────────────────────────────────────────────────────

  private bargeIn(turn: Turn): void {
    if (turn.bargedIn) return;
    turn.bargedIn = true;
    if (this.hooks.isResponseActive()) {
      this.hooks.send({ type: 'response.cancel' });
    }
    this.hooks.onBargeIn(turn.itemId);
  }

  private requestResponse(): void {
    if (this.hooks.isResponseActive()) {
      // Wait for the cancelled/finishing response to end first.
      this.pendingResponse = true;
    } else {
      this.hooks.send({ type: 'response.create' });
    }
  }

  private deleteIgnored(itemId: string): void {
    const t = this.ignored.get(itemId);
    if (t) clearTimeout(t);
    if (!this.ignored.delete(itemId) || this.closed) return;
    this.hooks.send({ type: 'conversation.item.delete', item_id: itemId });
  }

  private flushIgnored(): void {
    for (const id of [...this.ignored.keys()]) this.deleteIgnored(id);
  }

  // ─── Ring buffer ───────────────────────────────────────────────────────────

  private nowMs(): number {
    return this.written / (SR / 1000);
  }

  private slice(startMs: number, endMs: number): Float32Array {
    const oldest = Math.max(0, this.written - this.ring.length);
    const a = Math.max(oldest, Math.floor(startMs * (SR / 1000)));
    const b = Math.min(this.written, Math.floor(endMs * (SR / 1000)));
    const out = new Float32Array(Math.max(0, b - a));
    for (let i = 0; i < out.length; i++) {
      out[i] = this.ring[(a + i) % this.ring.length];
    }
    return out;
  }
}

function concat(chunks: Float32Array[]): Float32Array {
  const out = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
