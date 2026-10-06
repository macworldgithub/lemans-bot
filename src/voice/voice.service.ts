import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClientRequest } from 'http';
import { Socket as NetSocket } from 'net';
import { TLSSocket } from 'tls';
import WebSocket from 'ws';
import { LeadCaptureService } from './lead-capture.service';
import { LEMANS_SYSTEM_PROMPT } from './lemans-knowledge';

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
  | 'emergency'
  | 'general_enquiry'
  | 'unknown';

interface RealtimeSession {
  ws: WebSocket;
  onEvent: (event: any) => void;
  sessionStartedAtMs: number;
  greetingTriggeredAtMs: number | null;
  outputAudioTimer: ReturnType<typeof setTimeout> | null;
  firstAudioDeltaLogged: boolean;
  silenceRepromptCount: number;
  callerNumber: string;
  silenceTimer: ReturnType<typeof setTimeout> | null;
  callerTranscript: string;
  lastInputTranscriptAtMs: number;
  closing?: Promise<void>;
}

@Injectable()
export class VoiceService implements OnModuleDestroy {
  private readonly logger = new Logger(VoiceService.name);
  private sessions = new Map<string, RealtimeSession>();
  private readonly MAX_SILENCE_REPROMPTS = 2;

  constructor(
    private readonly config: ConfigService,
    private readonly leadCapture: LeadCaptureService,
  ) {}

  async onModuleDestroy(): Promise<void> {
    await Promise.allSettled(
      [...this.sessions.keys()].map((key) => this.closeSession(key)),
    );
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  // ─── Silence handling ────────────────────────────────────────────────────────

  handleSilenceTimeout(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.silenceRepromptCount += 1;

    if (session.silenceRepromptCount > this.MAX_SILENCE_REPROMPTS) {
      this.logger.log(
        `[${sessionId}] Max silence re-prompts reached — closing politely`,
      );
      this._injectAndRespond(
        sessionId,
        "It seems like you might have stepped away. No worries at all — feel free to call back whenever you're ready. Thanks for contacting Le Mans Entertainment, take care!",
      );
      setTimeout(() => {
        void this.closeSession(sessionId).catch(() => {});
      }, 8_000);
      return;
    }

    const reprompt = this._buildSilenceReprompt(session);
    this.logger.log(
      `[${sessionId}] Silence #${session.silenceRepromptCount} — re-prompting: "${reprompt}"`,
    );
    this._injectAndRespond(sessionId, reprompt);
  }

  handlePlaybackDone(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    if (session.silenceTimer) {
      clearTimeout(session.silenceTimer);
      session.silenceTimer = null;
    }

    const SILENCE_TIMEOUT_MS = 8_000;
    session.silenceTimer = setTimeout(() => {
      this.handleSilenceTimeout(sessionId);
    }, SILENCE_TIMEOUT_MS);

    this.logger.debug(
      `[${sessionId}] Silence countdown started (${SILENCE_TIMEOUT_MS}ms)`,
    );
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

    session.ws.send(
      JSON.stringify({
        type: 'session.instructions.append',
        delegation_id: null,
        content: `The caller has been quiet. Re-engage warmly by saying: ${text}`,
      }),
    );
  }

  // ─── Create session ──────────────────────────────────────────────────────────

  async createRealtimeSession(
    sessionId: string,
    onEvent: (event: any) => void,
    callerNumber = 'unknown',
  ): Promise<void> {
    const apiKey = this.config.get<string>('OPENAI_API_KEY');
    const model = 'gpt-live-1';
    const url = 'wss://api.openai.com/v1/live/sessions';
    const sessionStartedAtMs = Date.now();

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });

      this.instrumentHandshake(sessionId, 'GPT-Live', ws, sessionStartedAtMs);

      this.sessions.set(sessionId, {
        ws,
        onEvent,
        sessionStartedAtMs,
        greetingTriggeredAtMs: null,
        firstAudioDeltaLogged: false,
        outputAudioTimer: null,
        silenceRepromptCount: 0,
        callerNumber,
        silenceTimer: null,
        callerTranscript: '',
        lastInputTranscriptAtMs: 0,
      });
      let started = false;
      const startupTimer = setTimeout(() => {
        reject(new Error('AI session startup timed out'));
        void this.closeSession(sessionId, false).catch(() => {});
      }, 15_000);
      startupTimer.unref();

      ws.on('open', () => {
        if (
          this.sessions.get(sessionId)?.ws !== ws ||
          this.sessions.get(sessionId)?.closing
        )
          return;
        this.logger.log(
          `[${sessionId}] GPT-Live WebSocket connected in ${Date.now() - sessionStartedAtMs}ms`,
        );

        ws.send(
          JSON.stringify({
            type: 'session.start',
            session: {
              model,
              instructions: `${this.getSystemPrompt()}\n\nGPT-Live conversation guidance: Speak warmly and concisely in a natural Australian voice. Ask one clear question at a time. For callback, booking, complaint, or other staff follow-up requests, collect the caller’s name and request details, then delegate the task to the application to save the enquiry.`,
              audio: {
                format: { type: 'audio/pcm', rate: 24000 },
                output: {
                  voice:
                    this.config.get<string>('OPENAI_LIVE_VOICE') ?? 'quartz',
                },
              },
              delegation: { type: 'client' },
            },
          }),
        );
      });

      ws.on('message', async (data: WebSocket.Data) => {
        try {
          if (this.sessions.get(sessionId)?.ws !== ws) return;
          const event = JSON.parse(data.toString());
          if (event.type === 'session.started') {
            if (this.sessions.get(sessionId)?.closing) return;
            started = true;
            clearTimeout(startupTimer);
            resolve();
          }
          if (event.type === 'error' && !started) {
            clearTimeout(startupTimer);
            reject(new Error('AI session configuration failed'));
            void this.closeSession(sessionId, false).catch(() => {});
          }
          if (event.type === 'session.delegation.created') {
            await this.handleClientDelegation(sessionId, event.delegation?.id);
          }
          await this.handleRealtimeEvent(sessionId, event);
        } catch (err) {
          this.logger.error(`[${sessionId}] Failed to parse event:`, err);
        }
      });

      ws.on('error', (err) => {
        clearTimeout(startupTimer);
        this.logger.error(`[${sessionId}] GPT-Live WS error:`, err);
        onEvent({ type: 'realtime-error', error: { message: err.message } });
        reject(err);
      });

      ws.on('close', (code, reason) => {
        clearTimeout(startupTimer);
        if (!started)
          reject(new Error('AI session closed before startup completed'));
        this.logger.log(
          `[${sessionId}] GPT-Live WS closed: ${code} - ${reason}`,
        );
        if (this.sessions.get(sessionId)?.ws === ws) {
          void this.closeSession(sessionId, false).catch(() => {});
        }
      });
    });
  }

  // ─── Send audio ──────────────────────────────────────────────────────────────

  sendAudio(sessionId: string, base64Audio: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.closing || session.ws.readyState !== WebSocket.OPEN)
      return;
    session.ws.send(
      JSON.stringify({
        type: 'session.input_audio.append',
        audio: base64Audio,
      }),
    );
  }

  // ─── Trigger greeting ────────────────────────────────────────────────────────

  triggerGreeting(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.closing || session.ws.readyState !== WebSocket.OPEN)
      return;
    if (session.greetingTriggeredAtMs !== null) return;
    this.leadCapture.startSession(sessionId, session.callerNumber, {
      onSaved: (data) => session.onEvent({ type: 'lead-saved', data }),
      onError: () =>
        session.onEvent({
          type: 'realtime-error',
          error: {
            message:
              'Could not save call details. Please retry ending the call.',
          },
        }),
    });
    session.greetingTriggeredAtMs = Date.now();
    session.ws.send(
      JSON.stringify({
        type: 'session.instructions.append',
        delegation_id: null,
        content:
          'Greet the caller now in English as Chloe from LeMans Entertainment. Welcome them warmly, introduce yourself, ask how you can help, then pause and listen.',
      }),
    );
  }

  // ─── Event hub ───────────────────────────────────────────────────────────────

  private async handleRealtimeEvent(
    sessionId: string,
    event: any,
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    switch (event.type) {
      case 'session.started':
        this.logger.log(`[${sessionId}] GPT-Live session started`);
        break;
      case 'session.output_audio.delta':
        if (!session.firstAudioDeltaLogged) {
          session.firstAudioDeltaLogged = true;
          this.logger.log(
            `[${sessionId}] First audio at ${Date.now() - session.sessionStartedAtMs}ms`,
          );
        }
        session.onEvent({ type: 'audio-delta', delta: event.delta });
        if (session.outputAudioTimer) clearTimeout(session.outputAudioTimer);
        session.outputAudioTimer = setTimeout(() => {
          session.outputAudioTimer = null;
          session.onEvent({ type: 'audio-done' });
        }, 350);
        break;
      case 'session.output_transcript.delta':
        this.leadCapture.appendTranscript(
          sessionId,
          'assistant',
          event.delta ?? '',
          event.start_ms,
          event.end_ms,
        );
        session.onEvent({ type: 'transcript-delta', delta: event.delta });
        break;
      case 'session.input_transcript.delta':
        if (Date.now() - session.lastInputTranscriptAtMs > 1500) {
          session.onEvent({ type: 'user-transcript-reset' });
        }
        session.lastInputTranscriptAtMs = Date.now();
        session.callerTranscript += event.delta ?? '';
        this.leadCapture.appendTranscript(
          sessionId,
          'user',
          event.delta ?? '',
          event.start_ms,
          event.end_ms,
        );
        session.onEvent({
          type: 'user-transcript',
          transcript: session.callerTranscript,
        });
        session.silenceRepromptCount = 0;
        if (session.silenceTimer) {
          clearTimeout(session.silenceTimer);
          session.silenceTimer = null;
        }
        if (session.outputAudioTimer) {
          clearTimeout(session.outputAudioTimer);
          session.outputAudioTimer = null;
          session.onEvent({ type: 'speech-started' });
        }
        session.onEvent({ type: 'user-transcript-delta', delta: event.delta });
        break;
      case 'session.instructions.appended':
        break;
      case 'response.event':
        break;
      case 'session.delegation.created':
        session.onEvent({
          type: 'delegation-created',
          delegation: event.delegation,
        });
        break;
      case 'session.closed':
        session.onEvent({ type: 'audio-done' });
        break;
      case 'error':
        this.logger.error(
          `[${sessionId}] GPT-Live error: ${JSON.stringify(event.error)}`,
        );
        session.onEvent({ type: 'realtime-error', error: event.error });
        break;
      default:
        this.logger.debug(
          `[${sessionId}] Unhandled GPT-Live event: ${event.type}`,
        );
    }
  }

  // GPT-Live delegates to our Responses backend, which has the save_lead tool.
  private async handleClientDelegation(
    sessionId: string,
    delegationId?: string,
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || !delegationId || session.closing) return;
    try {
      const result = await this.leadCapture.captureLead(sessionId);
      this.sendDelegationResult(session.ws, delegationId, result);
    } catch {
      if (session.ws.readyState === WebSocket.OPEN) {
        session.ws.send(
          JSON.stringify({
            type: 'session.commentary.append',
            delegation_id: delegationId,
            content:
              'The enquiry has not been confirmed as saved. Please apologize briefly; do not claim it was logged. The application will retry saving at the end of the call.',
          }),
        );
      }
    }
  }

  private sendDelegationResult(
    ws: WebSocket,
    delegationId: string,
    result: Record<string, unknown>,
  ): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    const content = this.savedLeadMessage(result);
    ws.send(
      JSON.stringify({
        type: 'session.commentary.append',
        delegation_id: delegationId,
        content,
      }),
    );
  }

  private savedLeadMessage(result: Record<string, unknown>): string {
    if (result.event_type === 'emergency') {
      return 'The incident information collected so far has been saved. Direct the caller to the nearest staff member or Track Marshall immediately, or to Triple Zero (000) if anyone is in danger or needs urgent medical help. Do not delay urgent help to collect contact details.';
    }
    if (result.capture_status !== 'complete') {
      return 'A partial call record was saved. Ask for any missing caller name, callback phone number, or enquiry details, one question at a time. Delegate again once the caller responds.';
    }
    const destination =
      result.assignedTo === 'Skye'
        ? 'Skye'
        : result.event_type === 'complaint'
          ? 'the duty manager'
          : 'the team';
    return `The caller details and enquiry were successfully saved in the database for ${destination} to follow up. Tell the caller their enquiry is logged. Ask whether they have any corrections or additional details.`;
  }

  public startExternalSession(callId: string, callerNumber?: string): void {
    this.leadCapture.startSession('phone:' + callId, callerNumber, { callId });
  }

  public appendExternalTranscript(
    callId: string,
    role: 'user' | 'assistant',
    delta: string,
    startMs?: number,
    endMs?: number,
  ): void {
    this.leadCapture.appendTranscript(
      'phone:' + callId,
      role,
      delta,
      startMs,
      endMs,
    );
  }

  public finalizeExternalSession(callId: string): Promise<void> {
    return this.leadCapture.finalizeSession('phone:' + callId);
  }

  public async handleExternalDelegation(params: {
    callId: string;
    callerNumber?: string;
    callerTranscript: string;
    delegationId: string;
    sendCommentary: (content: string) => void;
    sendThinking?: (content: string) => void;
  }): Promise<void> {
    try {
      const result = await this.leadCapture.captureLead(
        'phone:' + params.callId,
      );
      params.sendCommentary(this.savedLeadMessage(result));
    } catch {
      params.sendCommentary(
        'The enquiry has not been confirmed as saved. Do not claim it was logged. The application will retry at call end.',
      );
    }
  }

  // Keep the session until final persistence completes; duplicate close events share one promise.
  closeSession(sessionId: string, drainTranscripts = true): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return Promise.resolve();
    if (session.closing) return session.closing;
    if (session.outputAudioTimer) clearTimeout(session.outputAudioTimer);
    if (session.silenceTimer) clearTimeout(session.silenceTimer);
    session.closing = (async () => {
      // Allow transcription of the final audio packets to arrive before closing the provider.
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          drainTranscripts && session.greetingTriggeredAtMs !== null ? 750 : 0,
        ),
      );
      if (
        session.ws.readyState === WebSocket.OPEN ||
        session.ws.readyState === WebSocket.CONNECTING
      )
        session.ws.close();
      await this.leadCapture.finalizeSession(sessionId);
      if (this.sessions.get(sessionId) === session)
        this.sessions.delete(sessionId);
      session.onEvent({ type: 'session-closed' });
    })().catch((error) => {
      session.closing = undefined;
      throw error;
    });
    return session.closing;
  }

  // ─── WS instrumentation ──────────────────────────────────────────────────────

  private instrumentHandshake(
    sessionId: string,
    provider: 'GPT-Live',
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
        this.logger.log(
          `[${sessionId}] ${provider} DNS lookup in ${Date.now() - startedAtMs}ms`,
        ),
      );
      socket.once('connect', () =>
        this.logger.log(
          `[${sessionId}] ${provider} TCP connect in ${Date.now() - startedAtMs}ms`,
        ),
      );
      (socket as TLSSocket).once('secureConnect', () =>
        this.logger.log(
          `[${sessionId}] ${provider} TLS handshake in ${Date.now() - startedAtMs}ms`,
        ),
      );
    };

    if (req.socket) attach(req.socket);
    req.once('socket', (s: NetSocket) => attach(s));
    ws.on('upgrade', () =>
      this.logger.log(
        `[${sessionId}] ${provider} WS upgrade in ${Date.now() - startedAtMs}ms`,
      ),
    );
  }

  // ─── System prompt & tools ───────────────────────────────────────────────────

  public getSystemPrompt(): string {
    return LEMANS_SYSTEM_PROMPT;
  }
}
