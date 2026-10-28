// Generates the fake-microphone audio used by the end-to-end test:
// silence while Chloe greets, the caller's question, then silence while she answers.
// Usage: node e2e/make-audio.mjs   (reads OPENAI_API_KEY from the repo root .env)
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const envFile = readFileSync(path.join(here, '../../.env'), 'utf8');
const apiKey = process.env.OPENAI_API_KEY ?? envFile.match(/^OPENAI_API_KEY=(.+)$/m)?.[1]?.trim();
if (!apiKey) throw new Error('OPENAI_API_KEY not found');

// Each fixture: [seconds of silence, words] pairs, played in order by the fake mic.
export const FIXTURES = {
  'caller-hours': [
    [15, 'Hi there! What time are you open on Saturday?'],
    [14, "Perfect, thanks. That's all I needed, bye!"],
    [40, ''],
  ],
  // Says nothing: Chloe should check "are you still there?" and then hang up.
  'caller-silent': [[90, '']],
  // Behaviour scenarios (behaviour.spec.ts). Gaps leave room for Chloe's reply.
  'caller-kids-price': [
    [15, 'Hi, how much is a go-kart party for my eight year old?'],
    [16, "Great, thanks. That's all I needed, bye!"],
    [40, ''],
  ],
  'caller-corporate': [
    [15, "Hi, what's your price for a team building day for forty staff?"],
    [16, 'Yes please, put me through to the corporate team.'],
    [20, 'Okay, thanks. Bye!'],
    [40, ''],
  ],
  'caller-pregnant': [
    [15, "Hi, I'm pregnant. Can I still do the go-karts?"],
    [16, 'Okay, thanks anyway. Bye!'],
    [40, ''],
  ],
  'caller-lead': [
    [15, "Hi, I'd like someone to call me back about a bucks party please, I don't want to be transferred."],
    [12, "My name's Jake, my mobile is oh four one two, three four five, six seven eight. It's for twelve people on Saturday the fourteenth of November."],
    [16, "Yes, that's all correct."],
    [18, "Great, thanks. Bye!"],
    [40, ''],
  ],
  // Talks over Chloe's long answer: she should stop and answer the new question.
  'caller-interrupt': [
    [16, 'Can you tell me about all of your activities and everything you have there?'],
    [4, 'Sorry, sorry, actually just tell me how old you have to be to drive the go-karts.'],
    [16, 'Thanks, bye!'],
    [40, ''],
  ],
};

async function speak(text) {
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice: 'alloy', input: text, response_format: 'pcm' }),
  });
  if (!res.ok) throw new Error(`TTS failed: ${res.status} ${await res.text()}`);
  return Buffer.from(await res.arrayBuffer()); // 24 kHz, 16-bit, mono PCM
}

function wav(pcm, sampleRate = 24000) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

const silence = (seconds) => Buffer.alloc(Math.round(seconds * 24000) * 2);

// Pass fixture names to regenerate only those: node e2e/make-audio.mjs caller-lead
const only = process.argv.slice(2);
for (const [name, parts] of Object.entries(FIXTURES)) {
  if (only.length && !only.includes(name)) continue;
  const chunks = [];
  for (const [pause, text] of parts) {
    chunks.push(silence(pause));
    if (text) chunks.push(await speak(text));
  }
  const pcm = Buffer.concat(chunks);
  const out = path.join(here, 'fixtures', `${name}.wav`);
  writeFileSync(out, wav(pcm));
  console.log(`wrote ${out} (${(pcm.length / 48000).toFixed(1)} s)`);
}
