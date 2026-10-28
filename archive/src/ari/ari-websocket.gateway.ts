import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { WebSocket } from 'ws';
import { ConfigService } from '@nestjs/config';

/**
 * WebSocket Gateway for handling Asterisk externalMedia audio streaming.
 *
 * This gateway receives 8kHz, 16-bit signed PCM mono audio from Asterisk
 * via externalMedia WebSocket transport and forwards it to the AI service.
 *
 * Flow:
 * 1. Asterisk connects to this WebSocket when externalMedia channel is created
 * 2. Binary audio frames are received from Asterisk
 * 3. Audio is processed by AI service
 * 4. AI response audio is sent back to Asterisk
 * 5. When AI is done, the call is hung up
 */
import { WebSocketServer } from 'ws';

@Injectable()
export class AriWebSocketGateway implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AriWebSocketGateway.name);
  private server: WebSocketServer;

  // Map WebSocket connections to call IDs
  private readonly wsToCallId = new Map<WebSocket, string>();
  private readonly callIdToWs = new Map<string, WebSocket>();

  // Audio processing handlers
  private audioProcessor:
    | ((callId: string, audioBuffer: Buffer) => Promise<Buffer | null>)
    | null = null;

  constructor(private readonly configService: ConfigService) {}

  onModuleInit() {
    try {
      const port = this.configService.get<number>('WEBSOCKET_PORT', 9090);
      this.logger.log(`Attempting to start WebSocket server on port ${port}`);

      this.server = new WebSocketServer({ port });

      this.server.on('connection', (ws: WebSocket, request) => {
        this.handleConnection(ws, request);
      });

      this.server.on('error', (error) => {
        this.logger.error('WebSocket server error:', error);
      });

      this.logger.log(`WebSocket server listening on port ${port}`);
      this.logger.log('AriWebSocketGateway initialized');
    } catch (error) {
      this.logger.error('Failed to start WebSocket server:', error);
    }
  }

  onModuleDestroy() {
    this.logger.log('AriWebSocketGateway shutting down');
    if (this.server) {
      this.server.close();
    }
  }

  async handleConnection(client: WebSocket, request: any) {
    const url = request.url || '';
    const callId = this.extractCallIdFromUrl(url);

    if (!callId) {
      this.logger.warn('WebSocket connection without call ID - closing');
      client.close(1008, 'Call ID required');
      return;
    }

    this.logger.log(`WebSocket connected for call=${callId}`);

    // Store mapping
    this.wsToCallId.set(client, callId);
    this.callIdToWs.set(callId, client);

    client.on('message', (data: Buffer) => {
      this.handleAudioMessage(callId, data);
    });

    client.on('error', (error) => {
      this.logger.error(`WebSocket error for call=${callId}: ${error.message}`);
    });

    client.on('close', (code, reason) => {
      this.logger.log(
        `WebSocket closed for call=${callId}: code=${code}, reason=${reason}`,
      );
      this.cleanupConnection(client);
    });
  }

  handleDisconnect(client: WebSocket) {
    this.cleanupConnection(client);
  }

  /**
   * Set the audio processing function that will handle incoming audio
   * and return AI response audio.
   */
  setAudioProcessor(
    processor: (callId: string, audioBuffer: Buffer) => Promise<Buffer | null>,
  ) {
    this.audioProcessor = processor;
  }

  /**
   * Send audio data to the WebSocket (to Asterisk)
   */
  sendAudioToCall(callId: string, audioBuffer: Buffer): boolean {
    const ws = this.callIdToWs.get(callId);
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return false;
    }

    try {
      ws.send(audioBuffer);
      return true;
    } catch (error) {
      this.logger.error(
        `Failed to send audio to call=${callId}: ${(error as Error).message}`,
      );
      return false;
    }
  }

  /**
   * Close the WebSocket connection for a specific call
   */
  closeCallConnection(callId: string): void {
    const ws = this.callIdToWs.get(callId);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.close(1000, 'Call completed');
    }
  }

  /**
   * Handle incoming binary audio data from Asterisk
   */
  private async handleAudioMessage(callId: string, data: Buffer) {
    if (!this.audioProcessor) {
      this.logger.warn(`No audio processor set for call=${callId}`);
      return;
    }

    try {
      // Process audio through AI service
      const responseBuffer = await this.audioProcessor(callId, data);

      if (responseBuffer && responseBuffer.length > 0) {
        // Send AI response back to Asterisk
        const sent = this.sendAudioToCall(callId, responseBuffer);
        if (!sent) {
          this.logger.warn(`Failed to send audio response to call=${callId}`);
        }
      }
    } catch (error) {
      this.logger.error(
        `Audio processing error for call=${callId}: ${(error as Error).message}`,
      );

      // If processing fails repeatedly, consider hanging up the call
      const ws = this.callIdToWs.get(callId);
      if (ws && ws.readyState === WebSocket.OPEN) {
        this.logger.warn(
          `Closing WebSocket for call=${callId} due to processing error`,
        );
        ws.close(1011, 'Audio processing error');
      }
    }
  }

  /**
   * Extract call ID from WebSocket URL or query parameters
   */
  private extractCallIdFromUrl(url: string): string | null {
    try {
      // Try to extract from query parameter: ws://localhost:9090/?callId=xxx
      const urlObj = new URL(url, 'http://localhost');
      const callId = urlObj.searchParams.get('callId');
      if (callId) {
        return callId;
      }

      // Try to extract from path: ws://localhost:9090/xxx
      const pathParts = urlObj.pathname.split('/').filter((p) => p.length > 0);
      if (pathParts.length > 0) {
        return pathParts[pathParts.length - 1];
      }

      return null;
    } catch (error) {
      this.logger.error(`Failed to extract call ID from URL: ${url}`);
      return null;
    }
  }

  /**
   * Clean up connection mappings
   */
  private cleanupConnection(client: WebSocket) {
    const callId = this.wsToCallId.get(client);
    if (callId) {
      this.wsToCallId.delete(client);
      this.callIdToWs.delete(callId);
      this.logger.log(`Cleaned up connection for call=${callId}`);
    }
  }

  /**
   * Get health status of the WebSocket gateway
   */
  getHealth() {
    return {
      listening: Boolean(this.server),
      port: this.configService.get<number>('WEBSOCKET_PORT', 9090),
      activeConnections: this.wsToCallId.size,
      activeCalls: this.callIdToWs.size,
    };
  }
}
