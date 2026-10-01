import { performance } from 'node:perf_hooks';
import { CallLatency } from './call-latency';

/** Observability only. These estimates never control GPT, input, or RTP playback. */
export class PhoneTurnLatency {
  private voicedMs = 0;
  private silentMs = 0;
  private speaking = false;
  private lastVoicedAt: number | null = null;
  private speechEndAt: number | null = null;
  private speechTurn = 0;
  private outputBurst = 0;
  private outputTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(private readonly callId: string) {}

  logConfig() {
    CallLatency.event(this.callId, 'LOCAL_VAD_DIAGNOSTICS', {
      source: 'local_energy_estimate',
      rms_threshold: 600,
      min_voiced_ms: 80,
      silence_ms: 300,
      output_gap_ms: 350,
      changes_provider_vad: false,
    });
  }

  input(audio: Buffer, receivedAtMs = performance.now()) {
    if (this.closed || !audio.length) return;
    let energy = 0;
    for (const byte of audio) {
      const value = ~byte & 0xff;
      const magnitude = (((value & 15) << 3) + 132) << ((value >> 4) & 7);
      const sample = magnitude - 132;
      energy += sample * sample;
    }
    const durationMs = audio.length / 8; // PCMU 8 kHz, one byte/sample.
    if (Math.sqrt(energy / audio.length) >= 600) {
      this.lastVoicedAt = receivedAtMs;
      this.silentMs = 0;
      this.voicedMs += durationMs;
      if (!this.speaking && this.voicedMs >= 80) {
        this.speaking = true;
        this.speechEndAt = null;
        this.speechTurn++;
        CallLatency.event(this.callId, 'USER_SPEECH_STARTED', {
          source: 'local_energy_estimate',
          turn: this.speechTurn,
        });
      }
    } else {
      this.voicedMs = 0;
      this.silentMs += durationMs;
      if (this.speaking && this.silentMs >= 300) {
        this.speaking = false;
        this.speechEndAt = this.lastVoicedAt;
        CallLatency.event(this.callId, 'USER_SPEECH_STOPPED', {
          source: 'local_energy_estimate',
          turn: this.speechTurn,
          silence_observed_ms: this.silentMs,
          speech_end_elapsed_ms:
            this.speechEndAt === null
              ? null
              : CallLatency.elapsed(this.callId, this.speechEndAt),
        });
      }
    }
  }

  output() {
    if (this.closed) return;
    if (!this.outputTimer) {
      const now = performance.now();
      const burst = ++this.outputBurst;
      const endToAudio =
        this.speechEndAt === null || this.speaking || now < this.speechEndAt
          ? null
          : Number((now - this.speechEndAt).toFixed(3));
      // Live has no primary voice-response-created or voice-response-done event.
      // Do not mislabel delegated Responses events as voice turn events.
      CallLatency.event(this.callId, 'RESPONSE_CREATED', {
        source: 'provider_event_unavailable',
        audio_burst: burst,
        duration_ms: null,
      });
      CallLatency.event(this.callId, 'FIRST_RESPONSE_AUDIO', {
        source: 'session.output_audio.delta',
        audio_burst: burst,
        kind: this.speechTurn === 0 ? 'initial_greeting' : 'conversation',
        local_speech_turn: this.speechTurn,
        overlaps_local_speech: this.speaking,
      });
      CallLatency.turnSummary(this.callId, {
        audio_burst: burst,
        local_speech_turn: this.speechTurn,
        kind: this.speechTurn === 0 ? 'initial_greeting' : 'conversation',
        speech_end_source: 'local_energy_estimate',
        speech_end_to_response_ms: null,
        response_created_source: 'not_exposed_by_GPT-Live',
        speech_end_to_first_audio_ms: endToAudio,
      });
    } else {
      clearTimeout(this.outputTimer);
    }
    this.outputTimer = setTimeout(() => {
      this.outputTimer = null;
      CallLatency.event(this.callId, 'RESPONSE_DONE', {
        source: 'output_gap_estimate',
        audio_burst: this.outputBurst,
        gap_ms: 350,
        provider_response_done: false,
      });
    }, 350);
    this.outputTimer.unref();
  }

  close() {
    this.closed = true;
    if (this.outputTimer) clearTimeout(this.outputTimer);
    this.outputTimer = null;
  }
}
