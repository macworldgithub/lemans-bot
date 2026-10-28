/**
 * Measures OpenAI time-to-first-token with the real receptionist prompt.
 * Usage: npx tsx scripts/bench-llm.ts [model ...]
 */
import { buildInstructions } from '../src/agent/prompt.js';
import { config, KNOWLEDGE_DIR } from '../src/config.js';
import { loadKnowledge } from '../src/knowledge/loader.js';

const models = process.argv.slice(2).length ? process.argv.slice(2) : [config.OPENAI_LLM_MODEL];
const system = buildInstructions(loadKnowledge(KNOWLEDGE_DIR), { source: 'web', now: new Date(), timezone: config.TIMEZONE });
const questions = ['What time are you open on Saturday?', 'How much is a kids go-kart party?', 'Where are you located?', 'Can I bring a cake?'];

async function ttft(model: string, question: string) {
  const t0 = performance.now();
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${config.OPENAI_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: true,
      stream_options: { include_usage: true },
      ...(process.env.REASONING ? { reasoning_effort: process.env.REASONING } : {}),
      messages: [{ role: 'system', content: system }, { role: 'user', content: question }],
    }),
  });
  if (!res.ok) throw new Error(`${model}: ${res.status} ${await res.text()}`);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let first = 0;
  let cached = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const text = decoder.decode(value);
    if (!first && text.includes('"content":"')) first = performance.now() - t0;
    const m = text.match(/"cached_tokens":(\d+)/);
    if (m) cached = Number(m[1]);
  }
  return { first: Math.round(first), total: Math.round(performance.now() - t0), cached };
}

for (const model of models) {
  const rows = [];
  for (const q of questions) rows.push(await ttft(model, q));
  const firsts = rows.map((r) => r.first).sort((a, b) => a - b);
  console.log(`${model.padEnd(16)} ttft ms: ${rows.map((r) => r.first).join(', ')}  median ${firsts[Math.floor(firsts.length / 2)]}  cached tokens: ${rows.map((r) => r.cached).join(',')}`);
}
