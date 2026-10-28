import path from 'node:path';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';
import { z } from 'zod';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_ROOT = path.resolve(BACKEND_ROOT, '..');

// One .env at the repo root is shared by the API, the agent worker and tooling.
dotenv.config({ path: path.join(REPO_ROOT, '.env'), quiet: true });

const optional = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() ? v.trim() : undefined));

// Values like "0412XXXXXX   # comment" or "TO FILL" are placeholders, not numbers.
const phoneNumber = optional.transform((v) => {
  const cleaned = v?.replace(/#.*$/, '').trim();
  return cleaned && /^\+?[0-9 ]{6,}$/.test(cleaned) ? cleaned.replace(/\s+/g, '') : undefined;
});

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3010),
  API_URL: z.string().url().default('http://127.0.0.1:3010'),
  INTERNAL_API_SECRET: z.string().min(16),
  CORS_ORIGIN: optional,

  LIVEKIT_URL: z.string().url(),
  LIVEKIT_API_KEY: z.string().min(1),
  LIVEKIT_API_SECRET: z.string().min(1),
  AGENT_NAME: z.string().default('lemans-receptionist'),
  // Worker refuses new calls above this CPU load (0–1). Library default 0.7 in production.
  AGENT_LOAD_THRESHOLD: z.coerce.number().min(0.1).max(1).optional(),

  AGENT_PIPELINE: z.enum(['cascade', 'realtime', 'live']).default('cascade'),
  OPENAI_API_KEY: z.string().min(1),
  OPENAI_LLM_MODEL: z.string().default('gpt-4.1-mini'),
  OPENAI_REALTIME_MODEL: z.string().default('gpt-realtime'),
  OPENAI_LIVE_VOICE: z.string().default('marin'),
  // GPT-Live (AGENT_PIPELINE=live): full-duplex voice model + a backend model that runs the tools.
  GPT_LIVE_MODEL: z.string().default('gpt-live-1'),
  GPT_LIVE_VOICE: z.string().default('marin'),
  GPT_LIVE_BACKEND_MODEL: optional,
  GPT_LIVE_BACKEND_REASONING: z.enum(['none', 'minimal', 'low', 'medium', 'high']).default('low'),
  DEEPGRAM_API_KEY: z.string().min(1),
  DEEPGRAM_MODEL: z.string().default('nova-3'),
  DEEPGRAM_LANGUAGE: z.string().default('en-AU'),
  ELEVENLABS_API_KEY: z.string().min(1),
  ELEVENLABS_VOICE_ID: z.string().min(1),
  ELEVENLABS_MODEL: z.string().default('eleven_flash_v2_5'),

  MONGO_URI: optional,
  MONGO_DB: z.string().default('lemans_voice'),
  TIMEZONE: z.string().default('Australia/Melbourne'),

  // Transfer targets. Phone calls are REFERred here; unset = take a lead instead.
  TRANSFER_RESERVATIONS: phoneNumber,
  TRANSFER_CORPORATE: phoneNumber,
  TRANSFER_DUTY_MANAGER: phoneNumber,
  TRANSFER_MAIN: phoneNumber,
  TRANSFER_CORPORATE_LARGE: phoneNumber,
});

export type Config = z.infer<typeof schema>;

function load(): Config {
  const env = { ...process.env };
  // Accept the key names used by the previous implementation.
  env.DEEPGRAM_API_KEY ??= process.env.DeepGram_API_Key;
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${problems}`);
  }
  return parsed.data;
}

export const config = load();

export const KNOWLEDGE_DIR = path.join(REPO_ROOT, 'knowledge');
