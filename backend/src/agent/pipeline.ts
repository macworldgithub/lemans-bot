import { inference, voice, type VAD } from '@livekit/agents';
import * as deepgram from '@livekit/agents-plugin-deepgram';
import * as elevenlabs from '@livekit/agents-plugin-elevenlabs';
import * as openai from '@livekit/agents-plugin-openai';

import type { Config } from '../config.js';
import type { CallUserData } from './tools.js';

export const KEYTERMS = ['LeMans', 'Le Mans', 'Zero Latency', 'Laserzone', 'Arcadia', 'Dandenong', 'bucks', 'hens'];

/**
 * Session options for the chosen pipeline.
 * - cascade: Deepgram STT → OpenAI LLM → ElevenLabs TTS, local VAD + turn detector.
 * - realtime: OpenAI speech-to-speech (server-side turn detection, OpenAI voice).
 * - live: OpenAI GPT-Live, full duplex. The voice model talks and owns turn-taking; a backend
 *   model (Responses API) gets delegated requests and runs the tools.
 */
export function buildSessionOptions(
  cfg: Config,
  userData: CallUserData,
  live?: { backendInstructions: string; vad: VAD },
): voice.AgentSessionOptions<CallUserData> {
  // Self-hosted LiveKit has no Cloud inference gateway, so pin the local models.
  const interruption = { mode: 'vad' as const, minDuration: 400, resumeFalseInterruption: true, falseInterruptionTimeout: 1500 };

  if (cfg.AGENT_PIPELINE === 'live') {
    if (!live) throw new Error('live pipeline needs backend instructions and a VAD');
    return {
      userData,
      llm: new openai.realtime.GPTLiveModel({
        apiKey: cfg.OPENAI_API_KEY,
        model: cfg.GPT_LIVE_MODEL,
        voice: cfg.GPT_LIVE_VOICE,
        responsesOptions: {
          ...(cfg.GPT_LIVE_BACKEND_MODEL && { model: cfg.GPT_LIVE_BACKEND_MODEL }),
          instructions: live.backendInstructions,
          reasoning: { effort: cfg.GPT_LIVE_BACKEND_REASONING },
        },
      }),
      // The model decides turns; the VAD only cuts Chloe's audio when the caller barges in.
      vad: live.vad,
      turnHandling: { interruption },
    };
  }

  if (cfg.AGENT_PIPELINE === 'realtime') {
    return {
      userData,
      llm: new openai.realtime.RealtimeModel({
        apiKey: cfg.OPENAI_API_KEY,
        model: cfg.OPENAI_REALTIME_MODEL,
        voice: cfg.OPENAI_LIVE_VOICE,
      }),
      // OpenAI's server-side turn detection; no LiveKit turn detector model needed.
      turnHandling: { turnDetection: 'realtime_llm', interruption },
    };
  }

  return {
    userData,
    stt: new deepgram.STT({
      apiKey: cfg.DEEPGRAM_API_KEY,
      model: cfg.DEEPGRAM_MODEL,
      language: cfg.DEEPGRAM_LANGUAGE,
      keyterm: KEYTERMS,
      smartFormat: true,
      numerals: true,
    }),
    llm: new openai.LLM({ apiKey: cfg.OPENAI_API_KEY, model: cfg.OPENAI_LLM_MODEL, temperature: 0.4 }),
    tts: new elevenlabs.TTS({
      apiKey: cfg.ELEVENLABS_API_KEY,
      voiceId: cfg.ELEVENLABS_VOICE_ID,
      model: cfg.ELEVENLABS_MODEL,
      language: 'en',
    }),
    ttsTextTransforms: ['filter_markdown', 'filter_emoji'],
    turnHandling: {
      turnDetection: new inference.TurnDetector({ version: 'v1-mini' }),
      // 400 ms committed turns before Deepgram's final transcript arrived (split turns in testing).
      endpointing: { minDelay: 550, maxDelay: 3000 },
      interruption,
      preemptiveGeneration: { enabled: true },
    },
  };
}
