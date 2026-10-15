import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

export const LIVE_GREETING_TEXT =
  "Hi, you've reached Le Mans Entertainment. I'm Chloe. How can I help you today?";

let cached: { voice: string; audio: Buffer } | undefined;

export function loadLiveGreeting(voice: string): Buffer {
  if (!cached) {
    const metadata = JSON.parse(
      readFileSync(join(__dirname, 'assets/chloe-greeting.json'), 'utf8'),
    );
    const audio = readFileSync(join(__dirname, 'assets/chloe-greeting.ulaw'));
    if (
      metadata.text !== LIVE_GREETING_TEXT ||
      metadata.model !== 'gpt-live-1' ||
      metadata.encoding !== 'mulaw' ||
      metadata.sampleRate !== 8000 ||
      audio.length < 16_000 ||
      audio.length > 96_000 ||
      createHash('sha256').update(audio).digest('hex') !== metadata.sha256
    )
      throw new Error('Invalid saved GPT Live greeting; regenerate it');
    cached = { voice: metadata.voice, audio };
  }
  if (cached.voice !== voice)
    throw new Error(
      'Saved greeting voice differs from OPENAI_LIVE_VOICE; regenerate it',
    );
  return cached.audio;
}
