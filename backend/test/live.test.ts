import { afterEach, describe, expect, it, vi } from 'vitest';

import { createClosingJudge } from '../src/agent/closing.js';
import { buildLiveInstructions, GREETING } from '../src/agent/prompt.js';

const ctx = { source: 'web' as const, now: new Date('2026-10-24T00:00:00Z'), timezone: 'Australia/Melbourne' };

describe('GPT-Live instructions', () => {
  const { voice, backend } = buildLiveInstructions('Saturday: 9:15am - 11pm', ctx);

  it('gives both models the knowledge base and the call time', () => {
    for (const text of [voice, backend]) {
      expect(text).toContain('Saturday: 9:15am - 11pm');
      expect(text).toContain('Saturday 24 October 2026');
    }
  });

  it('opens with the fixed greeting and tells the voice model to delegate actions', () => {
    expect(voice).toContain(GREETING);
    expect(voice).toMatch(/delegate "end the call"/);
    expect(voice).not.toMatch(/transfer_call|save_lead|end_call/); // the voice model cannot see tools
  });

  it('tells the backend which tool does what', () => {
    expect(backend).toMatch(/transfer_call/);
    expect(backend).toMatch(/save_lead/);
    expect(backend).toMatch(/end_call/);
  });
});

describe('closing judge', () => {
  afterEach(() => vi.unstubAllGlobals());

  const reply = (content: string) =>
    vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 }));

  it('treats a goodbye from Chloe as the end without asking the model', async () => {
    const fetch = reply('NO');
    vi.stubGlobal('fetch', fetch);
    expect(await createClosingJudge('key')("That's all, thanks", 'No worries, bye!')).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not end on a goodbye that asks a question', async () => {
    vi.stubGlobal('fetch', reply('NO'));
    expect(await createClosingJudge('key')('Bye', 'Bye! Oh wait, did you want a callback?')).toBe(false);
  });

  it('asks the model when the closing has no goodbye word', async () => {
    const fetch = reply('YES');
    vi.stubGlobal('fetch', fetch);
    expect(await createClosingJudge('key')("That's all I needed", 'Have a great night!')).toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('keeps the line open when the model says no or fails', async () => {
    vi.stubGlobal('fetch', reply('NO'));
    expect(await createClosingJudge('key')('How much is it?', 'Thirty-nine dollars a head.')).toBe(false);
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('offline'))));
    expect(await createClosingJudge('key')("That's all", 'Have a good one!')).toBe(false);
  });
});
