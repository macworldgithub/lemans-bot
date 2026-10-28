// GPT-Live's voice model often wraps up a call ("Have a great night!") without delegating the
// hang-up to the backend, so end_call never runs. This judges, from the last exchange, whether
// the conversation is over, so the worker can hang up after a short grace period.

const SAID_GOODBYE = /\b(bye|goodbye)\b/i;

const PROMPT =
  'You watch a phone call between a caller and Chloe, a receptionist. Given the caller\'s last words and ' +
  "Chloe's reply, answer YES only if the conversation is finished: the caller has said goodbye or that they need " +
  'nothing more, and Chloe has replied with a closing line and has not asked a question. Otherwise answer NO. ' +
  'Answer with one word.';

export interface ClosingJudge {
  (caller: string, chloe: string): Promise<boolean>;
}

export function createClosingJudge(apiKey: string, model = 'gpt-4.1-mini', timeoutMs = 4_000): ClosingJudge {
  return async (caller, chloe) => {
    if (SAID_GOODBYE.test(chloe) && !chloe.trim().endsWith('?')) return true;
    if (!caller.trim()) return false;
    try {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          temperature: 0,
          max_tokens: 2,
          messages: [
            { role: 'system', content: PROMPT },
            { role: 'user', content: `Caller: ${caller}\nChloe: ${chloe}` },
          ],
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) return false;
      const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      return /^\s*yes/i.test(data.choices?.[0]?.message?.content ?? '');
    } catch {
      // Unsure means keep the line open; the dead-air check still ends abandoned calls.
      return false;
    }
  };
}
