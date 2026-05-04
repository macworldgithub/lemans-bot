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
};

type AiSession = {
  callId: string;
  ws: WebSocket;
  userSpeaking: boolean;
  responseActive: boolean;
  closed: boolean;
  processingAudio: boolean;
};

@Injectable()
export class AriService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AriService.name);
  private eventSocket: WebSocket | null = null;
  private lastEventAt: string | null = null;
  private connected = false;
  private readonly ariHttpClient: AxiosInstance;
  private readonly sessions = new Map<string, AriCallSession>();
  private readonly aiSessions = new Map<string, AiSession>();
  private readonly cleanupInProgress = new Set<string>();

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

    // Keep RTP for backward compatibility but don't use it for new calls
    this.ariRtpMediaService.setAudioFrameHandler((frame) => {
      this.handleInboundRtpFrame(frame.callId, frame.payload);
    });

    const autoConnect = this.configService.get<string>(
      'ASTERISK_ARI_AUTO_CONNECT',
    );
    if (autoConnect === 'true') {
      this.connectEventSocket();
    }
  }

  onModuleDestroy() {
    if (this.eventSocket) {
      this.eventSocket.close();
      this.eventSocket = null;
    }

    for (const callId of this.aiSessions.keys()) {
      this.cleanupAiSession(callId);
    }
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
    const channelId = event.channel?.id;
    const callerNumber = event.channel?.caller?.number || 'unknown';
    const calledNumber = event.channel?.dialplan?.exten || 'unknown';

    if (!channelId) {
      this.logger.warn('StasisStart received without channel ID');
      return;
    }

    if (channelId.startsWith('extmedia-')) {
      this.logger.debug(
        `Ignoring StasisStart for externalMedia channel=${channelId}`,
      );
      return;
    }

    if (this.sessions.has(channelId)) {
      this.logger.warn(
        `Ignoring duplicate StasisStart for channel=${channelId}`,
      );
      return;
    }

    this.logger.log(
      `StasisStart received. channel=${channelId || 'unknown'} caller=${callerNumber} called=${calledNumber}`,
    );

    const callId = channelId;
    const bridgeId = `bridge-${callId}`;

    let aiInstructions = this.getDefaultAiInstructions();

    // try {
    //   const voiceContext = await this.voiceService.handleIncomingCall({
    //     call_id: callId,
    //     caller_number: callerNumber,
    //     called_number: calledNumber,
    //   });

    //   if (voiceContext?.success) {
    //     this.logger.log(`Voice Service session created for call=${callId}`);
    //   }
    // } catch (error) {
    //   this.logger.warn(
    //     `Failed to create Voice Service session for ${callId}: ${(error as Error).message}`,
    //   );
    // }

    try {
      this.logger.log(`[${callId}] Step 1: Answering channel ${channelId}`);
      await this.answerChannel(channelId);
      this.logger.log(`[${callId}] Step 2: Creating bridge ${bridgeId}`);
      await this.createBridge(bridgeId);
      this.logger.log(
        `[${callId}] Step 3: Adding channel ${channelId} to bridge`,
      );
      await this.addChannelToBridge(bridgeId, channelId);

      // Use WebSocket externalMedia instead of RTP
      this.logger.log(
        `[${callId}] Step 4: Creating WebSocket externalMedia channel`,
      );
      const externalMediaChannelId =
        await this.createWebSocketExternalMediaChannel(callId);

      if (externalMediaChannelId) {
        this.logger.log(
          `[${callId}] Step 5: Adding externalMedia channel ${externalMediaChannelId} to bridge`,
        );
        await this.addChannelToBridge(bridgeId, externalMediaChannelId);
      }

      this.logger.log(`[${callId}] Step 6: Setting up session data`);
      this.sessions.set(callId, {
        callId,
        inboundChannelId: channelId,
        bridgeId,
        externalMediaChannelId,
        createdAt: new Date().toISOString(),
      });

      this.logger.log(`[${callId}] Step 7: Registering with RTP service`);
      // Register with RTP for backward compatibility but use WebSocket for audio
      this.ariRtpMediaService.registerCallSession(callId);
      this.logger.log(`[${callId}] Step 8: Starting AI session`);
      this.startAiSession(callId, aiInstructions);

      this.logger.log(
        `ARI bridge ready. call=${callId} bridge=${bridgeId} wsExtMedia=${externalMediaChannelId || 'none'}`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to initialize ARI call bridge for ${callId}: ${(error as Error).message}`,
      );
    }
  }

  private async handleChannelCleanup(event: AriEvent) {
    const channelId = event.channel?.id;
    if (!channelId) {
      return;
    }

    const session = this.findSessionByChannel(channelId);
    if (!session) {
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

  private async cleanupSession(callId: string) {
    if (this.cleanupInProgress.has(callId)) {
      return;
    }
    this.cleanupInProgress.add(callId);

    const session = this.sessions.get(callId);
    if (!session) {
      this.cleanupAiSession(callId);
      this.cleanupInProgress.delete(callId);
      return;
    }

    this.logger.log(`Cleaning up ARI session for call=${callId}`);

    if (session.externalMediaChannelId) {
      await this.safeHangupChannel(session.externalMediaChannelId);
    }
    await this.safeDestroyBridge(session.bridgeId);
    this.ariRtpMediaService.unregisterCallSession(callId);
    this.cleanupAiSession(callId);
    this.sessions.delete(callId);
    this.cleanupInProgress.delete(callId);
  }

  private handleInboundRtpFrame(callId: string, ulawPayload: Buffer) {
    // Keep RTP handler for backward compatibility but prioritize WebSocket
    const aiSession = this.aiSessions.get(callId);
    if (
      !aiSession ||
      aiSession.closed ||
      aiSession.ws.readyState !== WebSocket.OPEN ||
      aiSession.processingAudio // Don't use RTP if WebSocket is active
    ) {
      return;
    }

    try {
      aiSession.ws.send(
        JSON.stringify({
          type: 'input_audio_buffer.append',
          audio: ulawPayload.toString('base64'),
        }),
      );
    } catch (error) {
      this.logger.warn(
        `Failed to send inbound RTP frame to AI for call=${callId}: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Process WebSocket audio frames from Asterisk externalMedia
   * This receives 8kHz, 16-bit signed PCM mono audio and forwards to AI
   */
  private async processWebSocketAudio(
    callId: string,
    audioBuffer: Buffer,
  ): Promise<Buffer | null> {
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
            type: 'input_audio_buffer.append',
            audio: ulawBuffer.toString('base64'),
          }),
        );
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
    const apiKey = this.configService.get<string>('OPENAI_API_KEY');
    if (!apiKey) {
      this.logger.warn(
        `OPENAI_API_KEY missing. AI pipeline disabled for call=${callId}`,
      );
      return;
    }

    const model =
      this.configService.get<string>('OPENAI_REALTIME_MODEL') ||
      'gpt-4o-mini-realtime-preview';
    const wsUrl = `wss://api.openai.com/v1/realtime?model=${model}`;

    const ws = new WebSocket(wsUrl, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'OpenAI-Beta': 'realtime=v1',
      },
    });

    const aiSession: AiSession = {
      callId,
      ws,
      userSpeaking: false,
      responseActive: false,
      closed: false,
      processingAudio: false, // Initialize WebSocket audio flag
    };
    this.aiSessions.set(callId, aiSession);

    ws.on('open', () => {
      this.logger.log(`AI Realtime connected for call=${callId}`);

      ws.send(
        JSON.stringify({
          type: 'session.update',
          session: {
            modalities: ['audio', 'text'],
            instructions,
            input_audio_format: 'g711_ulaw',
            output_audio_format: 'g711_ulaw',
            turn_detection: {
              type: 'server_vad',
              threshold: 0.6,
              prefix_padding_ms: 300,
              silence_duration_ms: 500,
              create_response: true,
              interrupt_response: true,
            },
          },
        }),
      );
    });

    ws.on('message', (rawData: WebSocket.RawData) => {
      this.handleAiRealtimeEvent(callId, rawData.toString());
    });

    ws.on('error', (error) => {
      this.logger.warn(
        `AI Realtime error for call=${callId}: ${error.message}`,
      );
    });

    ws.on('close', () => {
      const session = this.aiSessions.get(callId);
      if (session) {
        session.closed = true;
      }
      this.aiSessions.delete(callId);
      this.logger.log(`AI Realtime closed for call=${callId}`);
    });
  }

  private handleAiRealtimeEvent(callId: string, rawEvent: string) {
    const aiSession = this.aiSessions.get(callId);
    if (!aiSession) {
      return;
    }

    try {
      const event = JSON.parse(rawEvent) as {
        type?: string;
        delta?: string;
        error?: { message?: string };
      };

      switch (event.type) {
        case 'response.created':
          aiSession.responseActive = true;
          break;
        case 'response.done':
          aiSession.responseActive = false;
          break;
        case 'input_audio_buffer.speech_started':
          aiSession.userSpeaking = true;
          this.handleBargeIn(callId);
          break;
        case 'input_audio_buffer.speech_stopped':
          aiSession.userSpeaking = false;
          break;
        case 'response.audio.delta':
          if (aiSession.userSpeaking || !event.delta) {
            return;
          }

          // Convert base64 ulaw to buffer
          const ulawBuffer = Buffer.from(event.delta, 'base64');

          this.logger.log(
            `[${callId}] AI speaking: ${ulawBuffer.length} bytes of audio`,
          );

          // If WebSocket is active, send via WebSocket, otherwise use RTP
          if (aiSession.processingAudio) {
            // Convert ulaw to slin for WebSocket
            const slinBuffer = this.convertUlawToSlin(ulawBuffer);
            this.ariWebSocketGateway.sendAudioToCall(callId, slinBuffer);
            this.logger.log(
              `[${callId}] Sent audio via WebSocket: ${slinBuffer.length} bytes`,
            );
          } else {
            // Use RTP for backward compatibility
            this.ariRtpMediaService.sendUlawToCall(callId, ulawBuffer);
            this.logger.log(
              `[${callId}] Sent audio via RTP: ${ulawBuffer.length} bytes`,
            );
          }
          break;
        case 'error':
          this.logger.warn(
            `AI event error for call=${callId}: ${event.error?.message || 'unknown'}`,
          );
          break;
        default:
          break;
      }
    } catch (error) {
      this.logger.warn(
        `Failed to parse AI event for call=${callId}: ${(error as Error).message}`,
      );
    }
  }

  private handleBargeIn(callId: string) {
    const aiSession = this.aiSessions.get(callId);
    if (!aiSession || aiSession.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    if (aiSession.responseActive) {
      aiSession.ws.send(JSON.stringify({ type: 'response.cancel' }));
      aiSession.responseActive = false;
      this.logger.debug(
        `Barge-in triggered response.cancel for call=${callId}`,
      );
    }
  }

  private cleanupAiSession(callId: string) {
    const aiSession = this.aiSessions.get(callId);
    if (!aiSession) {
      return;
    }

    aiSession.closed = true;
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
    return [
      'You are a professional phone voice assistant for a local tradie business.',
      'Speak briefly and naturally.',
      'Collect: caller name, issue, address/suburb, and best callback number.',
      'If interrupted, stop and listen immediately.',
    ].join(' ');
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
    const wsPort = this.configService.get<number>('WEBSOCKET_PORT', 9090);
    const wsHost = `127.0.0.1:${wsPort}`; // Use IP instead of localhost for Asterisk DNS

    this.logger.log(`[${callId}] Creating externalMedia with host=${wsHost}`);

    const response = await this.ariRequest<any>(
      'post',
      '/channels/externalMedia',
      {
        app: this.getAriApp(),
        channelId: `extmedia-${callId}`,
        external_host: wsHost, // Use IP instead of localhost
        format: 'slin', // 8kHz, 16-bit signed PCM mono
        direction: 'both',
        // Remove transport parameter - not supported in this Asterisk version
      },
    );

    this.logger.log(
      `Created WebSocket externalMedia channel for call=${callId} host=${wsHost} channelId=${response?.id}`,
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
