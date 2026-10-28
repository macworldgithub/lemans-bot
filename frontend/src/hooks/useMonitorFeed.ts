import { useEffect, useRef, useState } from 'react';

import { applyTranscriptEvent, type TranscriptEvent, type TranscriptLine } from '../lib/transcript';

export interface MonitoredCall {
  callId: string;
  source: 'phone' | 'web';
  callerNumber?: string;
  startedAt: number;
  endedAt?: number;
  lines: TranscriptLine[];
}

type AgentEvent =
  | { type: 'call-started'; callId: string; source: 'phone' | 'web'; callerNumber?: string; startedAt: number }
  | { type: 'call-ended'; callId: string; endedAt: number }
  | { type: 'transcript'; event: TranscriptEvent & { callId: string } }
  | { type: 'lead-saved' | 'transfer' | 'metrics' };

function reduce(calls: Record<string, MonitoredCall>, e: AgentEvent): Record<string, MonitoredCall> {
  switch (e.type) {
    case 'call-started':
      return { ...calls, [e.callId]: { callId: e.callId, source: e.source, callerNumber: e.callerNumber, startedAt: e.startedAt, lines: [] } };
    case 'call-ended': {
      const c = calls[e.callId];
      return c ? { ...calls, [e.callId]: { ...c, endedAt: e.endedAt } } : calls;
    }
    case 'transcript': {
      const c = calls[e.event.callId];
      return c ? { ...calls, [c.callId]: { ...c, lines: applyTranscriptEvent(c.lines, e.event) } } : calls;
    }
    default:
      return calls;
  }
}

/**
 * Live feed of every call from the API (Server-Sent Events). EventSource reconnects on
 * its own; each reconnect starts with a fresh snapshot.
 */
export function useMonitorFeed(onCallStarted?: (callId: string) => void) {
  const [calls, setCalls] = useState<Record<string, MonitoredCall>>({});
  const [connected, setConnected] = useState(false);
  const onStarted = useRef(onCallStarted);
  onStarted.current = onCallStarted;

  useEffect(() => {
    const source = new EventSource('/api/monitor/stream');
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.addEventListener('snapshot', (msg) => {
      const { calls: list } = JSON.parse((msg as MessageEvent<string>).data) as { calls: MonitoredCall[] };
      setCalls(Object.fromEntries(list.map((c) => [c.callId, c])));
    });
    source.addEventListener('agent', (msg) => {
      const event = JSON.parse((msg as MessageEvent<string>).data) as AgentEvent;
      setCalls((prev) => reduce(prev, event));
      if (event.type === 'call-started') onStarted.current?.(event.callId);
    });
    return () => source.close();
  }, []);

  return { calls: Object.values(calls).sort((a, b) => b.startedAt - a.startedAt), connected };
}
