import { Logger } from '@nestjs/common';
import { performance } from 'node:perf_hooks';

// Temporary diagnostics: milestones only, never audio, credentials or prompts.
export class CallLatency {
  private static readonly logger = new Logger('CallLatency');
  private static readonly calls = new Map<
    string,
    { start: number; seen: Set<string>; times: Map<string, number> }
  >();

  static start(callId: string) {
    if (this.calls.has(callId)) return;
    this.calls.set(callId, {
      start: performance.now(),
      seen: new Set(),
      times: new Map(),
    });
    this.mark(callId, 'T0', 'StasisStart received');
  }

  static mark(callId: string, stage: string, message: string) {
    const call = this.calls.get(callId);
    if (!call || call.seen.has(stage)) return;
    call.seen.add(stage);
    call.times.set(stage, performance.now() - call.start);
    const elapsed = (performance.now() - call.start)
      .toFixed(3)
      .padStart(8, '0');
    this.logger.log(
      '[CALL-LATENCY] ' +
        new Date().toISOString() +
        ' call=' +
        JSON.stringify(callId) +
        ' +' +
        elapsed +
        'ms ' +
        stage +
        ' ' +
        message,
    );
    if (stage === 'T15') this.summary(callId);
  }

  static elapsed(callId: string, at = performance.now()): number | null {
    const call = this.calls.get(callId);
    return call ? Number((at - call.start).toFixed(3)) : null;
  }

  static event(
    callId: string,
    stage: string,
    fields: Record<string, string | number | boolean | null>,
  ) {
    if (!this.calls.has(callId)) return;
    this.logger.log(
      '[CALL-LATENCY] ' +
        new Date().toISOString() +
        ' call=' +
        JSON.stringify(callId) +
        ' +' +
        this.elapsed(callId) +
        'ms ' +
        stage +
        ' ' +
        JSON.stringify(fields),
    );
  }

  static turnSummary(
    callId: string,
    fields: Record<string, string | number | boolean | null>,
  ) {
    if (!this.calls.has(callId)) return;
    this.logger.log(
      '[CALL-TURN-SUMMARY] call=' +
        JSON.stringify(callId) +
        ' ' +
        JSON.stringify(fields),
    );
  }

  private static summary(callId: string) {
    const call = this.calls.get(callId);
    if (!call || call.seen.has('SUMMARY')) return;
    call.seen.add('SUMMARY');
    const difference = (end: string, start = 'T0'): number | null => {
      const a = call.times.get(end),
        b = call.times.get(start);
      return a === undefined || b === undefined || a < b
        ? null
        : Number((a - b).toFixed(3));
    };
    this.logger.log(
      '[CALL-LATENCY-SUMMARY] call=' +
        JSON.stringify(callId) +
        ' ' +
        JSON.stringify({
          status: call.times.has('T15')
            ? 'first_audio_sent'
            : 'ended_before_first_audio',
          answer_ms: difference('T3', 'T2'),
          media_ready_ms: difference('MEDIA_READY'),
          gpt_connect_ms: difference('T9', 'T8'),
          session_ready_ms: difference('T11'),
          session_init_ms: difference('T11', 'T10'),
          greeting_first_audio_ms: difference('T14', 'GREETING'),
          first_rtp_ms: difference('T15'),
          baseline_first_rtp_ms: 2427,
        }),
    );
  }

  static end(callId: string) {
    this.summary(callId);
    this.mark(callId, 'END', 'Call diagnostics complete');
    this.calls.delete(callId);
  }
}
