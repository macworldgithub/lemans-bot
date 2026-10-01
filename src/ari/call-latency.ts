import { Logger } from '@nestjs/common';
import { performance } from 'node:perf_hooks';

// Temporary diagnostics: milestones only, never audio, credentials or prompts.
export class CallLatency {
  private static readonly logger = new Logger('CallLatency');
  private static readonly calls = new Map<
    string,
    { start: number; seen: Set<string> }
  >();

  static start(callId: string) {
    if (this.calls.has(callId)) return;
    this.calls.set(callId, { start: performance.now(), seen: new Set() });
    this.mark(callId, 'T0', 'StasisStart received');
  }

  static mark(callId: string, stage: string, message: string) {
    const call = this.calls.get(callId);
    if (!call || call.seen.has(stage)) return;
    call.seen.add(stage);
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
  }

  static end(callId: string) {
    this.mark(callId, 'END', 'Call diagnostics complete');
    this.calls.delete(callId);
  }
}
