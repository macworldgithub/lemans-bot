import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { ClientRequest } from 'http';
import { Model } from 'mongoose';
import { Socket as NetSocket } from 'net';
import { TLSSocket } from 'tls';
import WebSocket from 'ws';
import { Lead, LeadDocument } from './schemas/lead.schema';
import { ActiveCampaignService } from '../integrations/active-campaign.service';
import { LEMANS_SYSTEM_PROMPT, SAVE_LEAD_TOOL } from './lemans-knowledge';
import { LiveTranscriptGateway, TranscriptEvent } from './live-transcript.gateway';
import { SpeakerVerifierService } from './speaker-lock/speaker-verifier.service';
import { SpeakerLock, speakerLockOptionsFromEnv } from './speaker-lock/speaker-lock';

// ─── Types ────────────────────────────────────────────────────────────────────

export type EventType =
  | 'kids_party'
  | 'teen_party'
  | 'buck_party'
  | 'corporate'
  | 'adult_party'
  | 'karts'
  | 'vr'
  | 'activities'
  | 'booking_change'
  | 'complaint'
  | 'after_hours'
  | 'school_group'
  | 'general_enquiry'
  | 'unknown';

interface RealtimeSession {
  ws: WebSocket;
  elevenLabsWs: WebSocket | null;
  elevenLabsReady: boolean;
  textBuffer: string[];
  isResponseActive: boolean;
  onEvent: (event: any) => void;
  sessionStartedAtMs: number;
  openAiConnectedAtMs: number | null;
  elevenLabsConnectedAtMs: number | null;
  greetingTriggeredAtMs: number | null;
  firstResponseCreatedAtMs: number | null;
  firstAudioDeltaLogged: boolean;
  processedFunctionCallIds: Set<string>;
  lastQuestionAsked: string;
  lastRealAnswer: string;
  isRepromptActive: boolean;
  silenceRepromptCount: number;
  detectedEventType: EventType;
  corporateSizeTier: 'small' | 'large' | 'unknown';
  callerNumber: string;
  preferredLanguage: string;
  silenceTimer: ReturnType<typeof setTimeout> | null;
  currentBotItemId: string | null;
  inputSampleRate: number;
  speakerLock: SpeakerLock | null;
}

interface FunctionCallPayload {
  name: string;
  arguments: string;
  call_id: string;
}

// Transfer number map — populate from env
const TRANSFER_NUMBERS: Record<EventType, string | null> = {
  kids_party: process.env.TRANSFER_KIDS_PARTY ?? null,
  teen_party: process.env.TRANSFER_TEEN_PARTY ?? null,
  buck_party: process.env.TRANSFER_BUCK_PARTY ?? null,
  corporate: process.env.TRANSFER_CORPORATE ?? null,
  adult_party: process.env.TRANSFER_ADULT_PARTY ?? null,
  karts: process.env.TRANSFER_KARTS ?? null,
  vr: process.env.TRANSFER_VR ?? null,
  activities: process.env.TRANSFER_ACTIVITIES ?? null,
  booking_change: process.env.TRANSFER_BOOKING_CHANGE ?? null,
  complaint: process.env.TRANSFER_COMPLAINT ?? null,
  after_hours: null,
  school_group: process.env.TRANSFER_SCHOOL_GROUP ?? null,
  general_enquiry: process.env.TRANSFER_GENERAL ?? null,
  unknown: process.env.TRANSFER_GENERAL ?? null,
};

@Injectable()
export class VoiceService {
  private readonly logger = new Logger(VoiceService.name);
  private sessions = new Map<string, RealtimeSession>();
  private readonly MAX_SILENCE_REPROMPTS = 2;

  constructor(
    private readonly config: ConfigService,
    @InjectModel(Lead.name)
    private readonly leadModel: Model<LeadDocument>,
    private readonly activeCampaign: ActiveCampaignService,
    private readonly liveTranscript: LiveTranscriptGateway,
    private readonly speakerVerifier: SpeakerVerifierService,
  ) {}

  // ─── Type guard ─────────────────────────────────────────────────────────────

  private toFunctionCallPayload(value: unknown): FunctionCallPayload | null {
    if (!value || typeof value !== 'object') return null;
    const r = value as Record<string, unknown>;
    if (r.type !== 'function_call') return null;
    if (
      typeof r.name !== 'string' ||
      typeof r.arguments !== 'string' ||
      typeof r.call_id !== 'string'
    )
      return null;
    return { name: r.name, arguments: r.arguments, call_id: r.call_id };
  }

  // ─── Silence handling ────────────────────────────────────────────────────────

  handleSilenceTimeout(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    if (session.isResponseActive) {
      this.logger.debug(`[${sessionId}] Silence ignored — response still active`);
      return;
    }

    session.silenceRepromptCount += 1;

    if (session.silenceRepromptCount > this.MAX_SILENCE_REPROMPTS) {
      this.logger.log(`[${sessionId}] Max silence re-prompts reached — closing politely`);
      this._injectAndRespond(
        sessionId,
        "It seems like you might have stepped away. No worries at all — feel free to call back whenever you're ready. Thanks for contacting Le Mans Entertainment, take care!",
      );
      setTimeout(() => this.closeSession(sessionId), 8_000);
      return;
    }

    const reprompt = this._buildSilenceReprompt(session);
    this.logger.log(`[${sessionId}] Silence #${session.silenceRepromptCount} — re-prompting: "${reprompt}"`);
    this._injectAndRespond(sessionId, reprompt);
  }

  handlePlaybackDone(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    if (session.silenceTimer) {
      clearTimeout(session.silenceTimer);
      session.silenceTimer = null;
    }

    if (session.isResponseActive) return;

    const SILENCE_TIMEOUT_MS = 8_000;
    session.silenceTimer = setTimeout(() => {
      this.handleSilenceTimeout(sessionId);
    }, SILENCE_TIMEOUT_MS);

    this.logger.debug(`[${sessionId}] Silence countdown started (${SILENCE_TIMEOUT_MS}ms)`);
  }

  private _buildSilenceReprompt(session: RealtimeSession): string {
    if (session.silenceRepromptCount === 1) {
      return "Hey there, just checking if you're still with me! I'm happy to help with any questions about our tracks, karts, or booking.";
    }
    return "Are you still there? Let me know if you'd like me to grab your details so one of our team can give you a call back.";
  }

  private _injectAndRespond(sessionId: string, text: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.ws.readyState !== WebSocket.OPEN) return;

    session.isRepromptActive = true;

    session.ws.send(
      JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: `[SYSTEM: The caller has been quiet. Re-engage warmly by saying: "${text}"]`,
            },
          ],
        },
      }),
    );
    session.ws.send(JSON.stringify({ type: 'response.create' }));
  }

  // ─── Architecture ────────────────────────────────────────────────────────────

  /** gpt-live: OpenAI speaks (speech-to-speech). sandwich: OpenAI text -> ElevenLabs TTS. */
  private isGptLive(): boolean {
    return (this.config.get<string>('VOICE_ARCHITECTURE') ?? 'gpt-live') !== 'sandwich';
  }

  private readonly LIVE_OUTPUT_RATE = 24000;
  private readonly LIVE_VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse', 'marin', 'cedar'];

  private getLiveVoice(): string {
    const voice = this.config.get<string>('OPENAI_LIVE_VOICE') ?? 'marin';
    if (this.LIVE_VOICES.includes(voice)) return voice;
    this.logger.warn(`OPENAI_LIVE_VOICE="${voice}" is not supported by OpenAI; using "marin". Valid: ${this.LIVE_VOICES.join(', ')}`);
    return 'marin';
  }

  private getLiveInstructions(): string {
    const pace = this.config.get<string>('OPENAI_LIVE_SPEAKING_PACE') ?? 'brisk';
    const styles: Record<string, string> = {
      slow: 'Speak slowly and clearly.',
      normal: 'Speak at a natural, conversational pace.',
      brisk: 'Speak at a brisk, energetic pace.',
      fast: 'Speak fast, keeping every word clear.',
      very_fast: 'Speak very fast, keeping every word clear.',
    };
    return `${this.getSystemPrompt()}

[SPEAKING STYLE: ${styles[pace] ?? styles.brisk}]`;
  }

  // ─── Create session ──────────────────────────────────────────────────────────

  async createRealtimeSession(
    sessionId: string,
    onEvent: (event: any) => void,
    callerNumber = 'unknown',
  ): Promise<void> {
    const apiKey = this.config.get<string>('OPENAI_API_KEY');
    const model = this.config.get<string>('OPENAI_REALTIME_MODEL') ?? 'gpt-realtime-2.1';
    const inputSampleRate = Number(this.config.get<string>('OPENAI_INPUT_SAMPLE_RATE') ?? 24000);
    const vadThreshold = Number(this.config.get<string>('OPENAI_VAD_THRESHOLD') ?? 0.65);
    const vadPrefixPaddingMs = Number(this.config.get<string>('OPENAI_VAD_PREFIX_PADDING_MS') ?? 300);
    // Lower silence duration to 600ms (down from 2000ms) for snappy, natural conversation
    const vadSilenceDurationMs = Number(this.config.get<string>('OPENAI_VAD_SILENCE_DURATION_MS') ?? 600);
    const url = `wss://api.openai.com/v1/realtime?model=${model}`;
    const sessionStartedAtMs = Date.now();
    // Speaker lock: OpenAI detects turns but we decide whether to answer.
    const speakerLockOn = this.speakerVerifier.enabled && this.speakerVerifier.ready;
    const gptLive = this.isGptLive();

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });

      this.instrumentHandshake(sessionId, 'OpenAI', ws, sessionStartedAtMs);

      ws.on('open', () => {
        const openAiConnectedAtMs = Date.now();
        this.logger.log(`[${sessionId}] OpenAI connected in ${openAiConnectedAtMs - sessionStartedAtMs}ms`);

        ws.send(
          JSON.stringify({
            type: 'session.update',
            session: {
              type: 'realtime',
              model,
              output_modalities: gptLive ? ['audio'] : ['text'],
              audio: {
                ...(gptLive
                  ? {
                      output: {
                        format: { type: 'audio/pcm', rate: this.LIVE_OUTPUT_RATE },
                        voice: this.getLiveVoice(),
                      },
                    }
                  : {}),
                input: {
                  format: { type: 'audio/pcm', rate: inputSampleRate },
                  transcription: this.liveTranscript.getInputTranscriptionConfig(),
                  turn_detection: {
                    type: 'server_vad',
                    threshold: vadThreshold,
                    prefix_padding_ms: vadPrefixPaddingMs,
                    silence_duration_ms: vadSilenceDurationMs,
                    ...(speakerLockOn
                      ? { create_response: false, interrupt_response: false }
                      : {}),
                  },
                },
              },
              instructions: gptLive ? this.getLiveInstructions() : this.getSystemPrompt(),
              tools: [
                this.getSaveLeadTool(),
              ],
              tool_choice: 'auto',
            },
          }),
        );

        this.sessions.set(sessionId, {
          ws,
          elevenLabsWs: null,
          elevenLabsReady: false,
          textBuffer: [],
          isResponseActive: false,
          onEvent,
          sessionStartedAtMs,
          openAiConnectedAtMs,
          elevenLabsConnectedAtMs: null,
          greetingTriggeredAtMs: null,
          firstResponseCreatedAtMs: null,
          firstAudioDeltaLogged: false,
          processedFunctionCallIds: new Set(),
          lastQuestionAsked: '',
          lastRealAnswer: '',
          isRepromptActive: false,
          silenceRepromptCount: 0,
          detectedEventType: 'unknown',
          corporateSizeTier: 'unknown',
          callerNumber,
          preferredLanguage: 'english',
          silenceTimer: null,
          currentBotItemId: null,
          inputSampleRate,
          speakerLock: null,
        });
        if (speakerLockOn) this.attachSpeakerLock(sessionId);

        if (!gptLive) this.openElevenLabsStream(sessionId);
        resolve();
      });

      ws.on('message', async (data: WebSocket.Data) => {
        try {
          const event = JSON.parse(data.toString());
          await this.handleRealtimeEvent(sessionId, event);
        } catch (err) {
          this.logger.error(`[${sessionId}] Failed to parse event:`, err);
        }
      });

      ws.on('error', (err) => {
        this.logger.error(`[${sessionId}] OpenAI WS error:`, err);
        onEvent({ type: 'error', error: { message: err.message } });
        reject(err);
      });

      ws.on('close', (code, reason) => {
        this.logger.log(`[${sessionId}] OpenAI WS closed: ${code} - ${reason}`);
        this.closeElevenLabsWs(sessionId);
        this.sessions.get(sessionId)?.speakerLock?.close();
        this.sessions.delete(sessionId);
        this.liveTranscript.callEnded(sessionId);
        onEvent({ type: 'session-closed' });
      });
    });
  }

  // ─── Send audio ──────────────────────────────────────────────────────────────

  sendAudio(sessionId: string, base64Audio: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: base64Audio }));
    session.speakerLock?.pushPcm16(Buffer.from(base64Audio, 'base64'), session.inputSampleRate);
  }

  // ─── Trigger greeting ────────────────────────────────────────────────────────

  triggerGreeting(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.greetingTriggeredAtMs = Date.now();
    this.liveTranscript.callStarted(sessionId, 'web', session.callerNumber);
    session.ws.send(JSON.stringify({ type: 'response.create' }));
  }

  // ─── ElevenLabs stream ───────────────────────────────────────────────────────

  private openElevenLabsStream(sessionId: string, force = false): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    if (
      !force &&
      session.elevenLabsWs &&
      (session.elevenLabsWs.readyState === WebSocket.OPEN ||
        session.elevenLabsWs.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    this.closeElevenLabsWs(sessionId);

    const apiKey = this.config.get<string>('ELEVENLABS_API_KEY');
    const voiceId = this.config.get<string>('ELEVENLABS_VOICE_ID');
    const modelId = this.config.get<string>('ELEVENLABS_MODEL_ID') ?? 'eleven_turbo_v2_5';
    const wsUrl = `wss://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream-input?model_id=${modelId}&output_format=pcm_16000`;

    const elWs = new WebSocket(wsUrl);
    this.instrumentHandshake(sessionId, 'ElevenLabs', elWs, session.sessionStartedAtMs);

    elWs.on('open', () => {
      this.logger.log(`[${sessionId}] ElevenLabs connected (${modelId})`);
      session.elevenLabsConnectedAtMs = Date.now();

      elWs.send(
        JSON.stringify({
          text: ' ',
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75,
            style: 0.25,
            use_speaker_boost: true,
          },
          xi_api_key: apiKey,
        }),
      );

      if (session.elevenLabsWs === elWs) {
        session.elevenLabsReady = true;
        for (const text of session.textBuffer) {
          this.sendTextToElevenLabs(sessionId, text);
        }
        session.textBuffer = [];
      }
    });

    elWs.on('message', (data: WebSocket.Data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.audio) {
          if (!session.firstAudioDeltaLogged) {
            session.firstAudioDeltaLogged = true;
            this.logger.log(`[${sessionId}] First audio at ${Date.now() - session.sessionStartedAtMs}ms`);
          }
          session.onEvent({ type: 'audio-delta', delta: msg.audio });
        }
        if (msg.isFinal === true) {
          session.onEvent({ type: 'audio-done' });
        }
      } catch {
        // binary frames — ignore
      }
    });

    elWs.on('error', (err) => {
      this.logger.warn(`[${sessionId}] ElevenLabs WS error: ${err.message}`);
    });

    elWs.on('close', () => {
      if (session.elevenLabsWs === elWs) {
        session.elevenLabsReady = false;
      }
    });

    session.elevenLabsWs = elWs;
  }

  private sendTextToElevenLabs(sessionId: string, text: string): void {
    const session = this.sessions.get(sessionId);
    if (session?.elevenLabsWs?.readyState === WebSocket.OPEN) {
      session.elevenLabsWs.send(JSON.stringify({ text, try_trigger_generation: true }));
    }
  }

  private flushElevenLabsStream(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session?.elevenLabsWs?.readyState === WebSocket.OPEN) {
      session.elevenLabsWs.send(JSON.stringify({ text: '' }));
    }
  }

  private closeElevenLabsWs(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session?.elevenLabsWs) return;
    try {
      if (session.elevenLabsWs.readyState === WebSocket.CONNECTING) {
        session.elevenLabsWs.terminate();
      } else if (session.elevenLabsWs.readyState === WebSocket.OPEN) {
        session.elevenLabsWs.close();
      }
    } catch (err) {
      this.logger.warn(`[${sessionId}] Error closing ElevenLabs WS: ${err.message}`);
    }
    session.elevenLabsWs = null;
    session.elevenLabsReady = false;
    session.textBuffer = [];
  }

  // ─── Event hub ───────────────────────────────────────────────────────────────

  private async handleRealtimeEvent(sessionId: string, event: any): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    this.logger.debug(`[${sessionId}] Event: ${event.type}`);
    session.speakerLock?.handleEvent(event);

    switch (event.type) {
      case 'response.created':
        session.isResponseActive = true;
        session.currentBotItemId = null;
        session.silenceRepromptCount = 0;
        if (!session.firstResponseCreatedAtMs) {
          session.firstResponseCreatedAtMs = Date.now();
        }
        if (!this.isGptLive()) this.openElevenLabsStream(sessionId);
        break;

      case 'response.done': {
        session.isResponseActive = false;
        const outputs = (event as any).response?.output;
        if (Array.isArray(outputs)) {
          for (const item of outputs) {
            const fn = this.toFunctionCallPayload(item);
            if (fn) await this.handleFunctionCall(sessionId, fn);
          }
        }
        break;
      }

      case 'response.output_audio.delta':
        if (!session.firstAudioDeltaLogged) {
          session.firstAudioDeltaLogged = true;
          this.logger.log(`[${sessionId}] First audio at ${Date.now() - session.sessionStartedAtMs}ms`);
        }
        session.onEvent({ type: 'audio-delta', delta: event.delta, sampleRate: this.LIVE_OUTPUT_RATE });
        break;

      case 'response.output_audio.done':
        session.onEvent({ type: 'audio-done' });
        break;

      case 'response.output_text.delta':
      case 'response.text.delta':
      case 'response.output_audio_transcript.delta':
        if (this.isGptLive()) {
          // OpenAI already speaks; the text is for transcripts only.
        } else if (session.elevenLabsReady) {
          this.sendTextToElevenLabs(sessionId, event.delta);
        } else {
          session.textBuffer.push(event.delta);
        }
        session.onEvent({ type: 'transcript-delta', delta: event.delta });
        if (event.item_id) {
          session.currentBotItemId = event.item_id;
          this.emitTranscript(sessionId, {
            role: 'bot',
            id: event.item_id,
            kind: 'delta',
            text: event.delta,
          });
        }
        break;

      case 'response.output_text.done':
      case 'response.text.done':
      case 'response.output_audio_transcript.done': {
        const doneText: string | undefined = event.text ?? event.transcript;
        if (typeof doneText === 'string' && doneText.trim()) {
          session.lastQuestionAsked = doneText.trim();
          if (!session.isRepromptActive) {
            session.lastRealAnswer = doneText.trim();
          }
        }
        session.isRepromptActive = false;
        if (!this.isGptLive()) this.flushElevenLabsStream(sessionId);
        session.onEvent({ type: 'transcript-done', transcript: doneText });
        if (event.item_id) {
          this.emitTranscript(sessionId, {
            role: 'bot',
            id: event.item_id,
            kind: 'final',
            text: doneText,
          });
        }
        break;
      }

      case 'input_audio_buffer.speech_started':
        if (event.item_id) {
          this.emitTranscript(sessionId, { role: 'user', id: event.item_id, kind: 'start' });
        }
        // With the speaker lock, barge-in waits until the voice is verified
        // (SpeakerLock calls handleBargeIn via its onBargeIn hook).
        if (!session.speakerLock) this.handleBargeIn(sessionId, true);
        break;

      case 'conversation.item.input_audio_transcription.delta':
        this.emitTranscript(sessionId, {
          role: 'user',
          id: event.item_id,
          kind: 'delta',
          text: event.delta,
        });
        break;

      case 'conversation.item.input_audio_transcription.completed':
        session.onEvent({ type: 'user-transcript', transcript: event.transcript });
        this.emitTranscript(sessionId, {
          role: 'user',
          id: event.item_id,
          kind: 'final',
          text: event.transcript ?? '',
        });
        break;

      case 'conversation.item.input_audio_transcription.failed':
        this.logger.warn(`[${sessionId}] Transcription failed: ${JSON.stringify(event.error)}`);
        this.emitTranscript(sessionId, {
          role: 'user',
          id: event.item_id,
          kind: 'final',
          text: `[transcription failed: ${event.error?.message ?? 'unknown'}]`,
        });
        break;

      case 'response.function_call_arguments.done':
        await this.handleFunctionCall(sessionId, event);
        break;

      case 'response.output_item.done': {
        const fn = this.toFunctionCallPayload((event as any).item);
        if (fn) await this.handleFunctionCall(sessionId, fn);
        break;
      }

      case 'error':
        // Barge-in raced with response completion; harmless.
        if (event.error?.code === 'response_cancel_not_active') {
          session.isResponseActive = false;
          break;
        }
        this.logger.error(`[${sessionId}] OpenAI error: ${JSON.stringify(event.error)}`);
        if (event.error?.code === 'invalid_model') {
          this.logger.error(
            `[${sessionId}] Set OPENAI_REALTIME_MODEL in .env to a realtime model (e.g. gpt-realtime-2.1) and restart`,
          );
        }
        // Fatal setup errors: tell the browser instead of leaving it silent.
        if (['invalid_model', 'model_not_found', 'invalid_api_key', 'insufficient_quota'].includes(event.error?.code)) {
          session.onEvent({ type: 'realtime-error', error: { message: event.error?.message ?? 'OpenAI error' } });
        }
        break;
    }
  }

  // ─── Barge-in / speaker lock ─────────────────────────────────────────────────

  private handleBargeIn(sessionId: string, sendCancel: boolean): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    if (session.isResponseActive && session.currentBotItemId) {
      this.emitTranscript(sessionId, {
        role: 'bot',
        id: session.currentBotItemId,
        kind: 'interrupted',
      });
    }
    session.silenceRepromptCount = 0;
    session.isRepromptActive = false;
    if (session.silenceTimer) {
      clearTimeout(session.silenceTimer);
      session.silenceTimer = null;
    }
    if (sendCancel && session.isResponseActive) {
      try {
        session.ws.send(JSON.stringify({ type: 'response.cancel' }));
        session.isResponseActive = false;
      } catch (err) {
        this.logger.warn(`[${sessionId}] Cancel failed: ${err.message}`);
      }
    }
    if (!this.isGptLive()) {
      this.closeElevenLabsWs(sessionId);
      this.openElevenLabsStream(sessionId, true);
    }
    session.onEvent({ type: 'speech-started' });
  }

  private attachSpeakerLock(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.speakerLock = new SpeakerLock(
      this.speakerVerifier,
      {
        send: (event) => {
          if (session.ws.readyState === WebSocket.OPEN) {
            session.ws.send(JSON.stringify(event));
          }
        },
        isResponseActive: () => session.isResponseActive,
        onBargeIn: () => this.handleBargeIn(sessionId, false),
        onVerdict: (itemId, verdict) =>
          this.emitTranscript(sessionId, {
            role: 'user',
            id: itemId,
            kind: 'speaker',
            speaker: verdict,
          }),
        log: (msg) => this.logger.log(`[${sessionId}] SpeakerLock: ${msg}`),
      },
      speakerLockOptionsFromEnv((k) => this.config.get<string>(k)),
    );
  }

  // ─── Function call dispatcher ────────────────────────────────────────────────

  private async handleFunctionCall(sessionId: string, event: FunctionCallPayload): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const callId = event.call_id ?? null;
    if (callId && session.processedFunctionCallIds.has(callId)) {
      this.logger.debug(`[${sessionId}] Duplicate fn call ignored: ${callId}`);
      return;
    }
    if (callId) session.processedFunctionCallIds.add(callId);

    try {
      const args = JSON.parse(event.arguments);

      if (event.name === 'save_lead') {
        await this.handleSaveLead(sessionId, args, event.call_id);
      }
    } catch (err) {
      if (callId) session.processedFunctionCallIds.delete(callId);
      this.logger.error(`[${sessionId}] Function call error: ${err.message}`);
    }
  }

  // ─── save_lead ───────────────────────────────────────────────────────────────

  private async handleSaveLead(sessionId: string, args: any, callId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Corporate callers with > 40 people are assigned to Skye in ActiveCampaign
    const groupSize: number | null = args.group_size ?? null;
    const isCorporateLarge =
      args.event_type === 'corporate' &&
      groupSize !== null &&
      groupSize > 40;
    const assignedTo: string = isCorporateLarge ? 'Skye' : 'LeMans Inquiries';

    this.logger.log(
      `[${sessionId}] Saving lead — caller: ${args.caller_name} | type: ${args.event_type} | assigned: ${assignedTo}`,
    );

    const lead = await this.leadModel.create({
      callerName: args.caller_name,
      callerNumber: args.caller_number || session.callerNumber,
      callerEmail: args.caller_email,
      eventType: args.event_type,
      eventDate: args.event_date,
      groupSize: args.group_size,
      enquiryDetails: args.enquiry_details,
      assignedTo,
      callId: sessionId,
      source: 'voice_agent',
    });

    this.logger.log(`[${sessionId}] Lead saved: ${lead._id} (assigned to ${assignedTo})`);

    // ── Push to ActiveCampaign ───────────────────────────────────────────────
    const tagMap: Record<string, string> = {
      kids_party: 'KidsParty',
      teen_party: 'TeenParty',
      buck_party: 'BucksHens',
      corporate: 'Corporate',
      adult_party: 'AdultParty',
      karts: 'Karts',
      vr: 'VR',
      activities: 'Activities',
      booking_change: 'BookingChange',
      complaint: 'Complaint',
      after_hours: 'AfterHours',
      school_group: 'SchoolGroup',
      general_enquiry: 'GeneralEnquiry',
      unknown: 'Unknown',
    };
    const activeCampaignTag = tagMap[args.event_type] || args.event_type;

    try {
      await this.activeCampaign.createContact({
        firstName: args.caller_name,
        phone: args.caller_number || session.callerNumber,
        email: args.caller_email,
        tag: activeCampaignTag,
        fieldValues: [
          { field: 'EVENT_TYPE',   value: args.event_type ?? '' },
          { field: 'EVENT_DATE',   value: args.event_date ?? '' },
          { field: 'GROUP_SIZE',   value: String(args.group_size ?? '') },
          { field: 'ENQUIRY',      value: args.enquiry_details ?? '' },
          { field: 'ASSIGNED_TO',  value: assignedTo },
        ],
      });
      this.logger.log(`[${sessionId}] ActiveCampaign contact created (owner: ${assignedTo})`);
    } catch (err) {
      this.logger.warn(`[${sessionId}] ActiveCampaign push failed: ${err.message}`);
    }

    this._sendFunctionResult(sessionId, callId, {
      success: true,
      message: isCorporateLarge
        ? `I've passed your details straight to Skye — she'll give you a call back personally to plan everything!`
        : `All noted — someone from the team will give you a call back to go through everything with you!`,
      assigned_to: assignedTo,
    });

    session.ws.send(JSON.stringify({ type: 'response.create' }));
    session.onEvent({ type: 'lead-saved', data: { ...args, assignedTo } });
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  /** Sends a transcript line to the monitor hub and to this call's own client. */
  private emitTranscript(
    sessionId: string,
    event: Omit<TranscriptEvent, 'callId' | 'ts'>,
  ): void {
    const session = this.sessions.get(sessionId);
    if (!session || !event.id) return;
    const full = this.liveTranscript.publish({ callId: sessionId, ...event });
    session.onEvent({ type: 'live-transcript', event: full });
  }

  private _sendFunctionResult(sessionId: string, callId: string, output: object): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.ws.readyState !== WebSocket.OPEN) return;

    session.ws.send(
      JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: callId,
          output: JSON.stringify(output),
        },
      }),
    );
  }

  // ─── Cleanup ─────────────────────────────────────────────────────────────────

  closeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      this.closeElevenLabsWs(sessionId);
      session.speakerLock?.close();
      try {
        session.ws.close();
      } catch {
        // already closed
      }
      this.sessions.delete(sessionId);
      this.liveTranscript.callEnded(sessionId);
      this.logger.log(`[${sessionId}] Session closed`);
    }
  }

  // ─── WS instrumentation ──────────────────────────────────────────────────────

  private instrumentHandshake(
    sessionId: string,
    provider: 'OpenAI' | 'ElevenLabs',
    ws: WebSocket,
    startedAtMs: number,
  ): void {
    const wsWithReq = ws as WebSocket & { _req?: ClientRequest };
    const req = wsWithReq._req;
    if (!req) return;

    let attached = false;
    const attach = (socket: NetSocket): void => {
      if (attached) return;
      attached = true;
      socket.once('lookup', () =>
        this.logger.log(`[${sessionId}] ${provider} DNS lookup in ${Date.now() - startedAtMs}ms`),
      );
      socket.once('connect', () =>
        this.logger.log(`[${sessionId}] ${provider} TCP connect in ${Date.now() - startedAtMs}ms`),
      );
      (socket as TLSSocket).once('secureConnect', () =>
        this.logger.log(`[${sessionId}] ${provider} TLS handshake in ${Date.now() - startedAtMs}ms`),
      );
    };

    if (req.socket) attach(req.socket);
    req.once('socket', (s: NetSocket) => attach(s));
    ws.on('upgrade', () =>
      this.logger.log(`[${sessionId}] ${provider} WS upgrade in ${Date.now() - startedAtMs}ms`),
    );
  }

  // ─── System prompt & tools ───────────────────────────────────────────────────

  public getSystemPrompt(): string {
    return LEMANS_SYSTEM_PROMPT;
  }

  public getSaveLeadTool() {
    return SAVE_LEAD_TOOL;
  }
}
