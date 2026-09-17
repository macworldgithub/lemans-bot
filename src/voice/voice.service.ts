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

// ─── Types ────────────────────────────────────────────────────────────────────

export type EventType =
  | 'kids_party'
  | 'buck_party'
  | 'corporate'
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
}

interface FunctionCallPayload {
  name: string;
  arguments: string;
  call_id: string;
}

// Transfer number map — populate from env
const TRANSFER_NUMBERS: Record<EventType, string | null> = {
  kids_party: process.env.TRANSFER_KIDS_PARTY ?? null,
  buck_party: process.env.TRANSFER_BUCK_PARTY ?? null,
  corporate: process.env.TRANSFER_CORPORATE ?? null,
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

  // ─── Create session ──────────────────────────────────────────────────────────

  async createRealtimeSession(
    sessionId: string,
    onEvent: (event: any) => void,
    callerNumber = 'unknown',
  ): Promise<void> {
    const apiKey = this.config.get<string>('OPENAI_API_KEY');
    const model = this.config.get<string>('OPENAI_REALTIME_MODEL') ?? 'gpt-realtime-2';
    const inputSampleRate = Number(this.config.get<string>('OPENAI_INPUT_SAMPLE_RATE') ?? 24000);
    const vadThreshold = Number(this.config.get<string>('OPENAI_VAD_THRESHOLD') ?? 0.65);
    const vadPrefixPaddingMs = Number(this.config.get<string>('OPENAI_VAD_PREFIX_PADDING_MS') ?? 300);
    // Lower silence duration to 600ms (down from 2000ms) for snappy, natural conversation
    const vadSilenceDurationMs = Number(this.config.get<string>('OPENAI_VAD_SILENCE_DURATION_MS') ?? 600);
    const url = `wss://api.openai.com/v1/realtime?model=${model}`;
    const sessionStartedAtMs = Date.now();

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
              output_modalities: ['text'],
              audio: {
                input: {
                  format: { type: 'audio/pcm', rate: inputSampleRate },
                  turn_detection: {
                    type: 'server_vad',
                    threshold: vadThreshold,
                    prefix_padding_ms: vadPrefixPaddingMs,
                    silence_duration_ms: vadSilenceDurationMs,
                  },
                },
              },
              instructions: this.getSystemPrompt(),
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
        });

        this.openElevenLabsStream(sessionId);
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
        this.sessions.delete(sessionId);
        onEvent({ type: 'session-closed' });
      });
    });
  }

  // ─── Send audio ──────────────────────────────────────────────────────────────

  sendAudio(sessionId: string, base64Audio: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: base64Audio }));
  }

  // ─── Trigger greeting ────────────────────────────────────────────────────────

  triggerGreeting(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.greetingTriggeredAtMs = Date.now();
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

    switch (event.type) {
      case 'response.created':
        session.isResponseActive = true;
        session.silenceRepromptCount = 0;
        if (!session.firstResponseCreatedAtMs) {
          session.firstResponseCreatedAtMs = Date.now();
        }
        this.openElevenLabsStream(sessionId);
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

      case 'response.output_text.delta':
      case 'response.text.delta':
        if (session.elevenLabsReady) {
          this.sendTextToElevenLabs(sessionId, event.delta);
        } else {
          session.textBuffer.push(event.delta);
        }
        session.onEvent({ type: 'transcript-delta', delta: event.delta });
        break;

      case 'response.output_text.done':
      case 'response.text.done':
        if (typeof event.text === 'string' && event.text.trim()) {
          session.lastQuestionAsked = event.text.trim();
          if (!session.isRepromptActive) {
            session.lastRealAnswer = event.text.trim();
          }
        }
        session.isRepromptActive = false;
        this.flushElevenLabsStream(sessionId);
        session.onEvent({ type: 'transcript-done', transcript: event.text });
        break;

      case 'input_audio_buffer.speech_started':
        session.silenceRepromptCount = 0;
        session.isRepromptActive = false;
        if (session.silenceTimer) {
          clearTimeout(session.silenceTimer);
          session.silenceTimer = null;
        }
        if (session.isResponseActive) {
          try {
            session.ws.send(JSON.stringify({ type: 'response.cancel' }));
          } catch (err) {
            this.logger.warn(`[${sessionId}] Cancel failed: ${err.message}`);
          }
        }
        this.closeElevenLabsWs(sessionId);
        this.openElevenLabsStream(sessionId, true);
        session.onEvent({ type: 'speech-started' });
        break;

      case 'conversation.item.input_audio_transcription.completed':
        session.onEvent({ type: 'user-transcript', transcript: event.transcript });
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
        this.logger.error(`[${sessionId}] OpenAI error: ${JSON.stringify(event.error)}`);
        break;
    }
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
    try {
      await this.activeCampaign.createContact({
        firstName: args.caller_name,
        phone: args.caller_number || session.callerNumber,
        tag: args.event_type,
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
      try {
        session.ws.close();
      } catch {
        // already closed
      }
      this.sessions.delete(sessionId);
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
