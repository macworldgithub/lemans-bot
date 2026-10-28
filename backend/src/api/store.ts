import { EventEmitter } from 'node:events';

import type { AgentEvent, CallSource, LeadInfo, MonitorEvent, TranscriptEvent, TransferInfo, TurnMetrics } from '../shared/events.js';

export interface TranscriptLine {
  id: string;
  role: TranscriptEvent['role'];
  text: string;
  final: boolean;
  interrupted: boolean;
  ts: number;
}

export interface CallRecord {
  callId: string;
  source: CallSource;
  callerNumber?: string;
  startedAt: number;
  endedAt?: number;
  endReason?: string;
  lines: TranscriptLine[];
  leads: LeadInfo[];
  transfers: TransferInfo[];
  metrics: (TurnMetrics & { ts: number })[];
}

/** Same reducer as the browser, so a snapshot rebuilds the exact live view. */
export function applyTranscript(lines: TranscriptLine[], e: TranscriptEvent): void {
  let line = lines.find((l) => l.id === e.id && l.role === e.role);
  if (!line) {
    line = { id: e.id, role: e.role, text: '', final: false, interrupted: false, ts: e.ts };
    // Keep conversation order: a reply can be reported after the caller's next words.
    const at = lines.findIndex((l) => l.ts > e.ts);
    lines.splice(at < 0 ? lines.length : at, 0, line);
  }
  if (e.kind === 'interim') line.text = e.text ?? line.text;
  else if (e.kind === 'final') {
    line.text = e.text ?? line.text;
    line.final = true;
  } else if (e.kind === 'interrupted') line.interrupted = true;
}

/**
 * Live calls in memory (recent N kept for the monitor). Emits 'event' for every
 * applied agent event and 'ended' with the full record when a call finishes.
 */
export class CallStore extends EventEmitter<{ event: [MonitorEvent]; ended: [CallRecord] }> {
  private calls = new Map<string, CallRecord>();

  constructor(private readonly keep = 100) {
    super();
  }

  list(): CallRecord[] {
    return [...this.calls.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  get(callId: string): CallRecord | undefined {
    return this.calls.get(callId);
  }

  /** A lead the API has already stored: attach it to its call (when still in memory) and tell the monitor. */
  addLead(lead: LeadInfo): void {
    this.calls.get(lead.callId)?.leads.push(lead);
    this.emit('event', { type: 'lead-saved', lead });
  }

  apply(event: AgentEvent): void {
    const callId = event.type === 'transcript' ? event.event.callId : event.type === 'transfer' ? event.transfer.callId : event.callId;

    if (event.type === 'call-started') {
      this.calls.set(callId, {
        callId,
        source: event.source,
        callerNumber: event.callerNumber,
        startedAt: event.startedAt,
        lines: [],
        leads: [],
        transfers: [],
        metrics: [],
      });
      this.trim();
    }

    const call = this.calls.get(callId);
    if (!call) return; // events for calls started before this API process are ignored

    switch (event.type) {
      case 'transcript':
        applyTranscript(call.lines, event.event);
        break;
      case 'transfer':
        call.transfers.push(event.transfer);
        break;
      case 'metrics':
        call.metrics.push({ ...event.metrics, ts: event.ts });
        break;
      case 'call-ended':
        if (call.endedAt) return; // duplicate end
        call.endedAt = event.endedAt;
        call.endReason = event.reason;
        for (const l of call.lines) l.final = true;
        break;
      case 'call-started':
        break;
    }

    this.emit('event', event);
    if (event.type === 'call-ended') this.emit('ended', call);
  }

  private trim(): void {
    const excess = this.calls.size - this.keep;
    if (excess <= 0) return;
    const oldest = this.list().slice(-excess);
    for (const c of oldest) this.calls.delete(c.callId);
  }
}
