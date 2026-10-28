import { describe, expect, it } from 'vitest';

import { CallStore, type CallRecord } from '../src/api/store.js';
import type { AgentEvent } from '../src/shared/events.js';

const start = (callId: string, startedAt = 1): AgentEvent => ({ type: 'call-started', callId, source: 'web', startedAt });

describe('CallStore', () => {
  it('builds transcript lines from interim and final events', () => {
    const store = new CallStore();
    store.apply(start('c1'));
    store.apply({ type: 'transcript', event: { callId: 'c1', id: 'u0', role: 'user', kind: 'interim', text: 'hi wh', ts: 2 } });
    store.apply({ type: 'transcript', event: { callId: 'c1', id: 'u0', role: 'user', kind: 'interim', text: 'hi what time', ts: 3 } });
    store.apply({ type: 'transcript', event: { callId: 'c1', id: 'u0', role: 'user', kind: 'final', text: 'Hi, what time do you open?', ts: 4 } });
    store.apply({ type: 'transcript', event: { callId: 'c1', id: 'a1', role: 'bot', kind: 'final', text: 'We open at 9:45.', ts: 5 } });
    store.apply({ type: 'transcript', event: { callId: 'c1', id: 'a1', role: 'bot', kind: 'interrupted', ts: 6 } });

    const lines = store.get('c1')!.lines;
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ role: 'user', text: 'Hi, what time do you open?', final: true });
    expect(lines[1]).toMatchObject({ role: 'bot', interrupted: true });
  });

  it('emits ended once with all lines finalised', () => {
    const store = new CallStore();
    const ended: CallRecord[] = [];
    store.on('ended', (c) => ended.push(c));
    store.apply(start('c1'));
    store.apply({ type: 'transcript', event: { callId: 'c1', id: 'u0', role: 'user', kind: 'interim', text: 'hel', ts: 2 } });
    store.apply({ type: 'call-ended', callId: 'c1', endedAt: 9 });
    store.apply({ type: 'call-ended', callId: 'c1', endedAt: 10 });
    expect(ended).toHaveLength(1);
    expect(ended[0].endedAt).toBe(9);
    expect(ended[0].lines[0].final).toBe(true);
  });

  it('ignores events for unknown calls and keeps only the newest N', () => {
    const store = new CallStore(2);
    store.apply({ type: 'call-ended', callId: 'ghost', endedAt: 1 });
    store.apply(start('a', 1));
    store.apply(start('b', 2));
    store.apply(start('c', 3));
    expect(store.list().map((c) => c.callId)).toEqual(['c', 'b']);
  });
});

describe('applyTranscript ordering', () => {
  it('inserts a late-reported line by its timestamp', async () => {
    const { applyTranscript } = await import('../src/api/store.js');
    const lines: Parameters<typeof applyTranscript>[0] = [];
    applyTranscript(lines, { callId: 'c', id: 'u0', role: 'user', kind: 'interim', text: 'hi', ts: 20 });
    applyTranscript(lines, { callId: 'c', id: 'a0', role: 'bot', kind: 'final', text: 'Greeting', ts: 10 });
    expect(lines.map((l) => l.id)).toEqual(['a0', 'u0']);
  });
});
