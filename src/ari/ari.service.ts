import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import type { AxiosInstance } from 'axios';
import WebSocket from 'ws';
import { CallLatency } from './call-latency';
import { PhoneTurnLatency } from './phone-turn-latency';
import { VoiceService } from '../voice/voice.service';
import { AriRtpMediaService } from './ari-rtp-media.service';
import { AriWebSocketGateway } from './ari-websocket.gateway';

type AriEvent = {
  type?: string;
  timestamp?: string;
  channel?: {
    id?: string;
    caller?: {
      number?: string;
      name?: string;
    };
    dialplan?: {
      exten?: string;
      context?: string;
    };
  };
  application?: string;
};

type AriCallSession = {
  callId: string;
  inboundChannelId: string;
  bridgeId: string;
  externalMediaChannelId?: string;
  createdAt: string;
  ended: boolean;
  mediaReady: boolean;
  startup?: Promise<void>;
  cleanup?: Promise<void>;
  hangupInbound: boolean;
  turns: PhoneTurnLatency;
  callerNumber?: string;
  callerTranscript?: string;
  savedLead?: boolean;
};

type AiSession = {
  callId: string;
  ws: WebSocket;
  closed: boolean;
  processingAudio: boolean;
  ready: boolean;
  greetingSent: boolean;
  pendingInput: Buffer[];
  pendingInputBytes: number;
  pendingOutput: Buffer[];
  pendingOutputBytes: number;
  startupTimer: ReturnType<typeof setTimeout> | null;
};

@Injectable()
export class AriService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AriService.name);
  private eventSocket: WebSocket | null = null;
  private lastEventAt: string | null = null;
  private connected = false;
  private stopping = false;
  private readonly ariHttpClient: AxiosInstance;
  private readonly sessions = new Map<string, AriCallSession>();
  private readonly aiSessions = new Map<string, AiSession>();
  // Ten seconds of 8 kHz PCMU: bounded startup buffering, never silent truncation.
  private readonly maxStartupAudioBytes = 80_000;

  constructor(
    private readonly configService: ConfigService,
    private readonly ariRtpMediaService: AriRtpMediaService,
    private readonly ariWebSocketGateway: AriWebSocketGateway,
    private readonly voiceService: VoiceService,
  ) {
    this.ariHttpClient = axios.create({
      timeout: 10000,
      auth: {
        username: this.getAriUsername(),
        password: this.getAriPassword(),
      },
    });
  }

  onModuleInit() {
    // Set up WebSocket audio processor
    this.ariWebSocketGateway.setAudioProcessor((callId, audioBuffer) => {
      return this.processWebSocketAudio(callId, audioBuffer);
    });

    this.ariRtpMediaService.setStartupFailureHandler((callId, reason) => {
      this.failPhoneCall(callId, reason);
    });

    // Production phone calls use RTP
    this.ariRtpMediaService.setAudioFrameHandler((frame) => {
      this.handleInboundRtpFrame(
        frame.callId,
        frame.payload,
        frame.receivedAtMs,
      );
    });

    const autoConnect = this.configService.get<string>(
      'ASTERISK_ARI_AUTO_CONNECT',
    );
    if (autoConnect === 'true') {
      this.connectEventSocket();
    }
  }

  async onModuleDestroy() {
    this.stopping = true;
    if (this.eventSocket) {
      this.eventSocket.close();
      this.eventSocket = null;
    }

    await Promise.all(
      [...this.sessions.keys()].map((callId) =>
        this.cleanupSession(callId, true),
      ),
    );
  }

  getHealth() {
    return {
      status: this.connected ? 'connected' : 'disconnected',
      app: this.getAriApp(),
      ariUrl: this.getAriBaseUrl(),
      activeSessions: this.sessions.size,
      rtp: this.ariRtpMediaService.getHealth(),
      websocket: this.ariWebSocketGateway.getHealth(),
      lastEventAt: this.lastEventAt,
      timestamp: new Date().toISOString(),
    };
  }

  private connectEventSocket() {
    const wsUrl = this.getEventSocketUrl();

    this.logger.log(
      `Connecting ARI event socket: ${wsUrl.replace(/api_key=[^&]+/, 'api_key=***')}`,
    );
    this.eventSocket = new WebSocket(wsUrl);

    this.eventSocket.on('open', () => {
      this.connected = true;
      this.logger.log('ARI event socket connected');
    });

    this.eventSocket.on('message', async (rawData: WebSocket.RawData) => {
      this.lastEventAt = new Date().toISOString();

      try {
        const payload = JSON.parse(rawData.toString()) as AriEvent;
        if (payload.type === 'StasisStart') {
          if (
            payload.channel?.id &&
            !payload.channel.id.startsWith('extmedia-')
          ) {
            CallLatency.start(payload.channel.id);
          }
          await this.handleStasisStart(payload);
        } else if (
          payload.type === 'StasisEnd' ||
          payload.type === 'ChannelDestroyed'
        ) {
          await this.handleChannelCleanup(payload);
        }
      } catch (error) {
        this.logger.error(
          `Failed to parse ARI event: ${(error as Error).message}`,
        );
      }
    });

    this.eventSocket.on('close', () => {
      this.connected = false;
      this.logger.warn('ARI event socket disconnected');
    });

    this.eventSocket.on('error', (error) => {
      this.connected = false;
      this.logger.error(`ARI event socket error: ${error.message}`);
    });
  }

  private async handleStasisStart(event: AriEvent) {
    const callId = event.channel?.id;
    if (
      this.stopping ||
      !callId ||
      callId.startsWith('extmedia-') ||
      this.sessions.has(callId)
    )
      return;
    CallLatency.start(callId);
    CallLatency.mark(callId, 'T1', 'Incoming call processing begins');
    // Reserve before the first await so duplicate/end events see startup state.
    const session: AriCallSession = {
      callId,
      inboundChannelId: callId,
      bridgeId: 'bridge-' + callId,
      externalMediaChannelId: 'extmedia-' + callId,
      createdAt: new Date().toISOString(),
      ended: false,
      mediaReady: false,
      hangupInbound: false,
      turns: new PhoneTurnLatency(callId),
      callerNumber: event.channel?.caller?.number || 'unknown',
      callerTranscript: '',
      savedLead: false,
    };
    this.sessions.set(callId, session);
    session.startup = this.initializePhoneCall(session);
    try {
      await session.startup;
    } catch {
      if (!session.ended)
        this.logger.warn('ARI startup failed for call=' + callId);
      await this.cleanupSession(callId, !session.ended);
    }
  }

  private assertCallActive(session: AriCallSession) {
    if (session.ended || this.sessions.get(session.callId) !== session) {
      throw new Error('Call ended during startup');
    }
  }

  private async initializePhoneCall(session: AriCallSession) {
    const { callId, inboundChannelId, bridgeId } = session;
    CallLatency.mark(callId, 'T2', 'answer() called');
    await this.answerChannel(inboundChannelId);
    CallLatency.mark(callId, 'T3', 'Answer HTTP request completed');
    this.assertCallActive(session);

    // Independent of ARI media creation; handlers gate greeting/audio on readiness.
    this.ariRtpMediaService.registerCallSession(callId, true);
    this.startAiSession(callId, this.getDefaultAiInstructions());
    session.turns.logConfig();
    this.assertCallActive(session);
    CallLatency.mark(callId, 'T4', 'Bridge creation starts');
    await this.createBridge(bridgeId);
    CallLatency.mark(callId, 'T5', 'Bridge created');
    this.assertCallActive(session);
    await this.addChannelToBridge(bridgeId, inboundChannelId);
    this.assertCallActive(session);
    CallLatency.mark(
      callId,
      'INBOUND_JOINED',
      'Inbound channel added to bridge',
    );
    CallLatency.mark(
      callId,
      'T6',
      'External media creation starts (UDP/RTP ulaw)',
    );
    const externalChannelId =
      await this.createWebSocketExternalMediaChannel(callId);
    CallLatency.mark(
      callId,
      'T7',
      'External media creation HTTP request completed',
    );
    if (
      !externalChannelId ||
      externalChannelId !== session.externalMediaChannelId
    ) {
      throw new Error('Unexpected external media channel ID');
    }
    this.assertCallActive(session);

    // Channel membership and RTP endpoint lookup are genuinely independent.
    // Wait for both to settle before cleanup, including on either branch's failure.
    const results = await Promise.allSettled([
      this.addChannelToBridge(bridgeId, externalChannelId).then(() => {
        this.assertCallActive(session);
        CallLatency.mark(
          callId,
          'MEDIA_JOINED',
          'External media added to bridge',
        );
      }),
      this.bindPhoneRtpEndpoint(session, externalChannelId),
    ]);
    for (const result of results) {
      if (result.status === 'rejected') throw result.reason;
    }
    this.assertCallActive(session);
    session.mediaReady = true;
    CallLatency.mark(
      callId,
      'MEDIA_READY',
      'Bridge and call-specific RTP destination ready',
    );
    this.activatePhoneAudio(callId);
  }

  private async bindPhoneRtpEndpoint(
    session: AriCallSession,
    channelId: string,
  ) {
    const variablePath =
      '/channels/' + encodeURIComponent(channelId) + '/variable';
    const results = await Promise.allSettled([
      this.ariRequest<{ value: string }>('get', variablePath, {
        variable: 'UNICASTRTP_LOCAL_ADDRESS',
      }),
      this.ariRequest<{ value: string }>('get', variablePath, {
        variable: 'UNICASTRTP_LOCAL_PORT',
      }),
    ]);
    const [address, port] = results;
    if (address.status === 'rejected' || port.status === 'rejected') {
      throw new Error('Cannot obtain call-specific RTP endpoint');
    }
    this.assertCallActive(session);
    this.ariRtpMediaService.setRemoteEndpoint(
      session.callId,
      address.value.value,
      Number(port.value.value),
    );
    CallLatency.mark(
      session.callId,
      'RTP_BOUND',
      'Call-specific RTP destination registered',
    );
  }

  private async handleChannelCleanup(event: AriEvent) {
    const channelId = event.channel?.id;
    if (!channelId) {
      return;
    }

    const session = this.findSessionByChannel(channelId);
    if (!session) {
      CallLatency.end(channelId);
      return;
    }

    await this.cleanupSession(session.callId);
  }

  private findSessionByChannel(channelId: string): AriCallSession | undefined {
    for (const session of this.sessions.values()) {
      if (
        session.inboundChannelId === channelId ||
        session.externalMediaChannelId === channelId
      ) {
        return session;
      }
    }
    return undefined;
  }

  private cleanupSession(callId: string, hangupInbound = false): Promise<void> {
    const session = this.sessions.get(callId);
    if (!session) return Promise.resolve();
    session.hangupInbound ||= hangupInbound;
    if (session.cleanup) return session.cleanup;
    // Cancel locally before waiting for any in-flight ARI request.
    session.ended = true;
    session.turns.close();
    this.cleanupAiSession(callId);
    this.ariRtpMediaService.unregisterCallSession(callId);
    const leadFinalization = this.voiceService.finalizeExternalSession(callId).catch(() => {
      this.logger.error(`[${callId}] Final lead persistence failed`);
    });
    session.cleanup = (async () => {
      // Release a failed call immediately; late ARI resources are still reclaimed below.
      const earlyHangup = session.hangupInbound
        ? this.safeHangupChannel(session.inboundChannelId)
        : null;
      // A request already accepted by Asterisk may create a resource after hangup.
      // Wait for startup to settle, then delete the deterministic resource IDs.
      await session.startup?.catch(() => {});
      if (session.externalMediaChannelId) {
        await this.safeHangupChannel(session.externalMediaChannelId);
      }
      await this.safeDestroyBridge(session.bridgeId);
      if (earlyHangup) await earlyHangup;
      else if (session.hangupInbound)
        await this.safeHangupChannel(session.inboundChannelId);
      await leadFinalization;
      if (this.sessions.get(callId) === session) this.sessions.delete(callId);
      CallLatency.end(callId);
    })();
    return session.cleanup;
  }

  private handleInboundRtpFrame(
    callId: string,
    ulawPayload: Buffer,
    receivedAtMs?: number,
  ) {
    const call = this.sessions.get(callId);
    const ai = this.aiSessions.get(callId);
    if (!call || call.ended || !ai || ai.closed || ai.processingAudio) return;
    CallLatency.mark(callId, 'T12', 'First caller RTP audio received');
    call.turns.input(ulawPayload, receivedAtMs);
    if (!ai.ready || !call.mediaReady || ai.ws.readyState !== WebSocket.OPEN) {
      if (
        ai.pendingInputBytes + ulawPayload.length >
        this.maxStartupAudioBytes
      ) {
        this.failPhoneCall(callId, 'INPUT_BUFFER_LIMIT');
        return;
      }
      ai.pendingInput.push(Buffer.from(ulawPayload));
      ai.pendingInputBytes += ulawPayload.length;
      CallLatency.mark(
        callId,
        'INPUT_BUFFERED',
        'Caller audio buffered until session/media ready',
      );
      return;
    }
    this.forwardPhoneAudio(callId, ai, ulawPayload);
  }

  private forwardPhoneAudio(callId: string, ai: AiSession, payload: Buffer) {
    try {
      ai.ws.send(
        JSON.stringify({
          type: 'session.input_audio.append',
          audio: payload.toString('base64'),
        }),
      );
      CallLatency.mark(callId, 'T13', 'First caller audio forwarded to AI');
    } catch {
      this.failPhoneCall(callId, 'INPUT_SEND_FAILED');
    }
  }

  private activatePhoneAudio(callId: string) {
    const call = this.sessions.get(callId);
    const ai = this.aiSessions.get(callId);
    if (
      !call ||
      call.ended ||
      !call.mediaReady ||
      !ai ||
      ai.closed ||
      !ai.ready ||
      ai.ws.readyState !== WebSocket.OPEN
    )
      return;
    try {
      if (!ai.greetingSent) {
        ai.greetingSent = true;
        ai.ws.send(
          JSON.stringify({
            type: 'session.instructions.append',
            delegation_id: null,
            content:
              'Greet the caller now in English as Chloe from LeMans Entertainment. Welcome them warmly, introduce yourself, ask how you can help, then pause and listen.',
          }),
        );
        CallLatency.mark(callId, 'GREETING', 'Greeting instruction sent');
      }
      // Preserve ordered startup speech; no input is sent before session.started.
      for (const audio of ai.pendingInput) {
        if (call.ended) break;
        this.forwardPhoneAudio(callId, ai, audio);
      }
      ai.pendingInput = [];
      ai.pendingInputBytes = 0;
      for (const audio of ai.pendingOutput) {
        if (call.ended) break;
        this.ariRtpMediaService.sendUlawToCall(callId, audio);
      }
      ai.pendingOutput = [];
      ai.pendingOutputBytes = 0;
    } catch {
      this.failPhoneCall(callId, 'GREETING_SEND_FAILED');
    }
  }

  private failPhoneCall(callId: string, reason: string) {
    const call = this.sessions.get(callId);
    if (!call || call.ended) return;
    CallLatency.event(callId, 'CALL_FAILED', { reason });
    this.logger.warn(
      'Phone pipeline failed call=' +
        JSON.stringify(callId) +
        ' reason=' +
        reason,
    );
    void this.cleanupSession(callId, true);
  }

  /**
   * Process WebSocket audio frames from Asterisk externalMedia
   * This receives 8kHz, 16-bit signed PCM mono audio and forwards to AI
   */
  private async processWebSocketAudio(
    callId: string,
    audioBuffer: Buffer,
  ): Promise<Buffer | null> {
    CallLatency.mark(callId, 'T12', 'First caller WebSocket audio received');
    const aiSession = this.aiSessions.get(callId);
    if (!aiSession || aiSession.closed) {
      return null;
    }

    // Mark that we're processing WebSocket audio for this call
    aiSession.processingAudio = true;

    try {
      // Convert slin (16-bit PCM) to ulaw for OpenAI Realtime API
      const ulawBuffer = this.convertSlinToUlaw(audioBuffer);

      if (aiSession.ws.readyState === WebSocket.OPEN) {
        aiSession.ws.send(
          JSON.stringify({
            type: 'session.input_audio.append',
            audio: ulawBuffer.toString('base64'),
          }),
        );
        CallLatency.mark(callId, 'T13', 'First caller audio forwarded to AI');
      }
    } catch (error) {
      this.logger.error(
        `Failed to process WebSocket audio for call=${callId}: ${(error as Error).message}`,
      );
    }

    // Return null - AI responses will be handled via the existing WebSocket event handlers
    return null;
  }

  /**
   * Convert 16-bit signed PCM (slin) to G.711 u-law
   */
  private convertSlinToUlaw(slinBuffer: Buffer): Buffer {
    const ulawBuffer = Buffer.alloc(slinBuffer.length / 2);

    for (let i = 0; i < slinBuffer.length; i += 2) {
      const sample = slinBuffer.readInt16LE(i);
      ulawBuffer[i / 2] = this.linearToUlaw(sample);
    }

    return ulawBuffer;
  }

  /**
   * Convert 16-bit linear sample to 8-bit u-law
   */
  private linearToUlaw(sample: number): number {
    const BIAS = 0x84;
    const CLIP = 32635;

    // Get the sign and magnitude
    const sign = (sample >> 8) & 0x80;
    if (sign !== 0) {
      sample = -sample;
    }

    // Clip the magnitude
    if (sample > CLIP) {
      sample = CLIP;
    }

    // Add bias
    sample += BIAS;

    // Convert to u-law
    let ulaw = sign | ((sample >> 2) & 0x0f);
    ulaw |= ((sample >> 6) & 0x0f) << 4;

    return ~ulaw & 0xff;
  }

  /**
   * Convert G.711 u-law to 16-bit signed PCM (slin)
   */
  private convertUlawToSlin(ulawBuffer: Buffer): Buffer {
    const slinBuffer = Buffer.alloc(ulawBuffer.length * 2);

    for (let i = 0; i < ulawBuffer.length; i++) {
      const sample = this.ulawToLinear(ulawBuffer[i]);
      slinBuffer.writeInt16LE(sample, i * 2);
    }

    return slinBuffer;
  }

  /**
   * Convert 8-bit u-law to 16-bit linear sample
   */
  private ulawToLinear(ulaw: number): number {
    const BIAS = 0x84;

    // Invert all bits
    ulaw = ~ulaw & 0xff;

    // Extract sign and magnitude
    const sign = ulaw & 0x80;
    const exponent = (ulaw >> 4) & 0x07;
    const mantissa = ulaw & 0x0f;

    // Reconstruct the sample
    let sample = (mantissa << 4) | 0x08;
    sample <<= exponent;
    sample -= BIAS;

    if (sign !== 0) {
      sample = -sample;
    }

    return sample;
  }

  private startAiSession(callId: string, instructions: string) {
    if (this.aiSessions.has(callId)) return;
    const apiKey = this.configService.get<string>('OPENAI_API_KEY');
    if (!apiKey) throw new Error('OPENAI_API_KEY missing');
    CallLatency.mark(callId, 'T8', 'AI WebSocket connection starts');
    const ws = new WebSocket('wss://api.openai.com/v1/live/sessions', {
      headers: { Authorization: 'Bearer ' + apiKey },
      handshakeTimeout: 10_000,
    });
    const ai: AiSession = {
      callId,
      ws,
      closed: false,
      processingAudio: false,
      ready: false,
      greetingSent: false,
      pendingInput: [],
      pendingInputBytes: 0,
      pendingOutput: [],
      pendingOutputBytes: 0,
      startupTimer: setTimeout(
        () => this.failPhoneCall(callId, 'GPT_STARTUP_TIMEOUT'),
        15_000,
      ),
    };
    ai.startupTimer?.unref();
    this.aiSessions.set(callId, ai);
    ws.on('open', () => {
      if (
        ai.closed ||
        this.sessions.get(callId)?.ended ||
        this.aiSessions.get(callId) !== ai
      )
        return;
      CallLatency.mark(callId, 'T9', 'AI WebSocket connected');
      try {
        // Preserve the working Live protocol, prompt, voice and delegation settings.
        ws.send(
          JSON.stringify({
            type: 'session.start',
            session: {
              model: 'gpt-live-1',
              instructions,
              audio: {
                format: { type: 'audio/pcmu', rate: 8000 },
                output: {
                  voice:
                    this.configService.get<string>('OPENAI_LIVE_VOICE') ??
                    'quartz',
                },
              },
              delegation: { type: 'client' },
            },
          }),
        );
        CallLatency.mark(callId, 'T10', 'AI session configuration sent');
        CallLatency.event(callId, 'VAD_CONFIG', {
          source: 'session.start',
          mode: 'GPT-Live managed',
          turn_detection: 'omitted',
          threshold: 'omitted',
          prefix_padding_ms: 'omitted',
          silence_duration_ms: 'omitted',
          eagerness: 'omitted',
          create_response: 'omitted',
          interrupt_response: 'omitted',
          provider_speech_boundaries: 'not_exposed',
          provider_response_lifecycle: 'not_exposed',
        });
      } catch {
        this.failPhoneCall(callId, 'SESSION_START_SEND_FAILED');
      }
    });
    ws.on('message', (data: WebSocket.RawData) => {
      if (!ai.closed && this.aiSessions.get(callId) === ai)
        this.handleAiRealtimeEvent(callId, data.toString());
    });
    ws.on('error', () => this.failPhoneCall(callId, 'GPT_WEBSOCKET_ERROR'));
    ws.on('close', () => {
      if (!ai.closed && this.aiSessions.get(callId) === ai)
        this.failPhoneCall(callId, 'GPT_WEBSOCKET_CLOSED');
    });
  }

  private handleAiRealtimeEvent(callId: string, rawEvent: string) {
    const ai = this.aiSessions.get(callId);
    const call = this.sessions.get(callId);
    if (!ai || ai.closed || !call || call.ended) return;
    try {
      const event = JSON.parse(rawEvent) as { type?: string; delta?: string; delegation?: { id?: string; name?: string } };
      switch (event.type) {
        case 'session.started':
          if (ai.ready) return;
          ai.ready = true;
          this.voiceService.startExternalSession(callId, call.callerNumber);
          if (ai.startupTimer) clearTimeout(ai.startupTimer);
          ai.startupTimer = null;
          CallLatency.mark(callId, 'T11', 'AI session ready');
          this.activatePhoneAudio(callId);
          break;
        case 'session.input_transcript.delta':
          this.handleBargeIn(callId);
          call.callerTranscript = (call.callerTranscript || '') + (event.delta ?? '');
          this.voiceService.appendExternalTranscript(callId, 'user', event.delta ?? '');
          break;
        case 'session.output_transcript.delta':
          this.voiceService.appendExternalTranscript(callId, 'assistant', event.delta ?? '');
          break;
        case 'session.delegation.created': {
          const delegationId = event.delegation?.id;
          if (delegationId && ai.ws.readyState === WebSocket.OPEN) {
            void this.voiceService.handleExternalDelegation({
              callId,
              callerNumber: call.callerNumber,
              callerTranscript: call.callerTranscript || '',
              delegationId,
              sendCommentary: (content) => {
                if (ai.ws.readyState === WebSocket.OPEN) {
                  ai.ws.send(JSON.stringify({
                    type: 'session.commentary.append',
                    delegation_id: delegationId,
                    content,
                  }));
                }
              },
              sendThinking: (content) => {
                if (ai.ws.readyState === WebSocket.OPEN) {
                  ai.ws.send(JSON.stringify({
                    type: 'session.thinking.append',
                    delegation_id: delegationId,
                    content,
                  }));
                }
              },
            });
          } else {
            this.logger.warn(`[${callId}] Tool call failed name=client_delegation reason=missing_delegation_id`);
          }
          break;
        }
        case 'session.output_audio.delta': {
          if (!event.delta) return;
          CallLatency.mark(callId, 'T14', 'First AI audio delta received');
          call.turns.output();
          const audio = Buffer.from(event.delta, 'base64');
          if (ai.processingAudio) {
            const slin = this.convertUlawToSlin(audio);
            if (this.ariWebSocketGateway.sendAudioToCall(callId, slin)) {
              CallLatency.mark(
                callId,
                'T15',
                'First AI audio handed to Asterisk WebSocket',
              );
            }
          } else if (!call.mediaReady || !ai.ready) {
            if (
              ai.pendingOutputBytes + audio.length >
              this.maxStartupAudioBytes
            ) {
              this.failPhoneCall(callId, 'OUTPUT_BUFFER_LIMIT');
              return;
            }
            ai.pendingOutput.push(audio);
            ai.pendingOutputBytes += audio.length;
            CallLatency.mark(
              callId,
              'OUTPUT_BUFFERED',
              'GPT audio buffered until media/session ready',
            );
          } else {
            this.ariRtpMediaService.sendUlawToCall(callId, audio);
          }
          break;
        }
        case 'error':
          // Never print the provider payload: it can quote conversation content.
          this.failPhoneCall(callId, 'GPT_SESSION_ERROR');
          break;
        case 'session.closed':
          this.failPhoneCall(callId, 'GPT_SESSION_CLOSED');
          break;
        default:
          // Event types only, one per call, to detect protocol capability changes.
          if (event.type && /^[a-z0-9_.]{1,100}$/.test(event.type)) {
            CallLatency.mark(
              callId,
              'PROVIDER_EVENT:' + event.type,
              'Provider event type=' + event.type,
            );
          }
      }
    } catch {
      this.failPhoneCall(callId, 'GPT_EVENT_PROCESSING_FAILED');
    }
  }

  private handleBargeIn(callId: string) {
    const aiSession = this.aiSessions.get(callId);
    if (!aiSession || aiSession.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    // GPT-Live handles turn-taking; discard audio already queued for telephony.
    this.ariRtpMediaService.flushQueue(callId);
  }

  private cleanupAiSession(callId: string) {
    const aiSession = this.aiSessions.get(callId);
    if (!aiSession) {
      return;
    }

    aiSession.closed = true;
    if (aiSession.startupTimer) clearTimeout(aiSession.startupTimer);
    aiSession.startupTimer = null;
    aiSession.pendingInput = [];
    aiSession.pendingOutput = [];
    aiSession.pendingInputBytes = 0;
    aiSession.pendingOutputBytes = 0;
    try {
      if (aiSession.ws.readyState === WebSocket.OPEN) {
        aiSession.ws.close();
      } else if (aiSession.ws.readyState === WebSocket.CONNECTING) {
        aiSession.ws.terminate();
      }
    } catch (error) {
      this.logger.warn(
        `Failed to cleanup AI session for call=${callId}: ${(error as Error).message}`,
      );
    }

    // Close WebSocket connection if active
    if (aiSession.processingAudio) {
      this.ariWebSocketGateway.closeCallConnection(callId);
    }

    this.aiSessions.delete(callId);
  }

  private getDefaultAiInstructions() {
    return `${this.voiceService.getSystemPrompt()}\n\nGPT-Live telephony guidance: Speak warmly, concisely, and naturally in an Australian voice. Ask one clear question at a time, and stop to listen when interrupted. For callback, quote, booking assistance, party bookings, corporate events, complaints, or other staff follow-up requests, collect the caller’s name, phone number, and enquiry details, then delegate the task to the application to save the enquiry and sync with the CRM.`;
  }

  private async answerChannel(channelId: string) {
    await this.ariRequest(
      'post',
      `/channels/${encodeURIComponent(channelId)}/answer`,
    );
  }

  private async createBridge(bridgeId: string) {
    await this.ariRequest('post', '/bridges', {
      type: 'mixing',
      bridgeId,
      name: bridgeId,
    });
  }

  private async addChannelToBridge(bridgeId: string, channelId: string) {
    await this.ariRequest(
      'post',
      `/bridges/${encodeURIComponent(bridgeId)}/addChannel`,
      {
        channel: channelId,
      },
    );
  }

  private async createWebSocketExternalMediaChannel(
    callId: string,
  ): Promise<string | undefined> {
    // externalMedia without explicit transport defaults to UDP/RTP,
    // so point it at the RTP listener (port 6001) and use ulaw format
    // to match OpenAI's audio/pcmu input/output.
    const externalHost =
      this.configService.get<string>('ASTERISK_EXTERNAL_MEDIA_HOST') ||
      '127.0.0.1:6001';

    this.logger.log(
      `[${callId}] Creating externalMedia with host=${externalHost}`,
    );

    const response = await this.ariRequest<{ id?: string }>(
      'post',
      '/channels/externalMedia',
      {
        app: this.getAriApp(),
        channelId: `extmedia-${callId}`,
        external_host: externalHost,
        format: 'ulaw',
        direction: 'both',
      },
    );

    this.logger.log(
      `Created externalMedia channel for call=${callId} host=${externalHost} channelId=${response?.id}`,
    );
    return response?.id;
  }

  private async createExternalMediaChannel(
    callId: string,
    externalHost: string,
  ): Promise<string | undefined> {
    // Keep this method for backward compatibility
    const response = await this.ariRequest<any>(
      'post',
      '/channels/externalMedia',
      {
        app: this.getAriApp(),
        channelId: `extmedia-${callId}`,
        external_host: externalHost,
        format: 'ulaw',
        direction: 'both',
      },
    );

    return response?.id;
  }

  private async safeHangupChannel(channelId: string) {
    try {
      await this.ariRequest(
        'delete',
        `/channels/${encodeURIComponent(channelId)}`,
      );
    } catch (error) {
      this.logger.warn(
        `Failed to hangup channel ${channelId}: ${(error as Error).message}`,
      );
    }
  }

  private async safeDestroyBridge(bridgeId: string) {
    try {
      await this.ariRequest(
        'delete',
        `/bridges/${encodeURIComponent(bridgeId)}`,
      );
    } catch (error) {
      this.logger.warn(
        `Failed to destroy bridge ${bridgeId}: ${(error as Error).message}`,
      );
    }
  }

  private async ariRequest<T = unknown>(
    method: 'get' | 'post' | 'delete',
    path: string,
    params?: Record<string, string>,
  ): Promise<T> {
    const url = `${this.getAriBaseUrl()}/ari${path}`;
    const response = await this.ariHttpClient.request<T>({
      method,
      url,
      params,
    });
    return response.data;
  }

  private getAriBaseUrl(): string {
    return (
      this.configService.get<string>('ASTERISK_ARI_URL') ||
      'http://127.0.0.1:8088'
    );
  }

  private getAriApp(): string {
    return this.configService.get<string>('ASTERISK_ARI_APP') || 'ai-bridge';
  }

  private getAriUsername(): string {
    return this.configService.get<string>('ASTERISK_ARI_USERNAME') || 'tradie';
  }

  private getAriPassword(): string {
    return this.configService.get<string>('ASTERISK_ARI_PASSWORD') || 'tradie';
  }

  private getEventSocketUrl(): string {
    const httpUrl = this.getAriBaseUrl();
    const wsBaseUrl = httpUrl
      .replace(/^http:/i, 'ws:')
      .replace(/^https:/i, 'wss:');
    const query = new URLSearchParams({
      app: this.getAriApp(),
      api_key: `${this.getAriUsername()}:${this.getAriPassword()}`,
    });
    return `${wsBaseUrl}/ari/events?${query.toString()}`;
  }
}
