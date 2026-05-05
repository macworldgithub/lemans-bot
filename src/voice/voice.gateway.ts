// // import {
// //   WebSocketGateway,
// //   WebSocketServer,
// //   SubscribeMessage,
// //   MessageBody,
// //   ConnectedSocket,
// //   OnGatewayInit,
// //   OnGatewayConnection,
// //   OnGatewayDisconnect,
// // } from '@nestjs/websockets';
// // import { Server, Socket } from 'socket.io';
// // import { Logger } from '@nestjs/common';
// // import { VoiceService } from './voice.service';

// // interface PrewarmState {
// //   promise: Promise<void>;
// //   ready: boolean;
// //   failed: boolean;
// //   ttlTimer: ReturnType<typeof setTimeout>;
// // }

// // @WebSocketGateway({
// //   cors: {
// //     origin: '*',
// //   },
// // })
// // export class VoiceGateway
// //   implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
// // {
// //   @WebSocketServer() server: Server;
// //   private logger: Logger = new Logger('VoiceGateway');
// //   private readonly prewarmTtlMs = 60_000;
// //   private readonly prewarmStates = new Map<string, PrewarmState>();

// //   // Silence timer per session: fires after agent audio finishes + 5 s of no speech
// //   private readonly silenceTimers = new Map<
// //     string,
// //     ReturnType<typeof setTimeout>
// //   >();
// //   private readonly SILENCE_TIMEOUT_MS = 5_000;

// //   constructor(private readonly voiceService: VoiceService) {}

// //   afterInit(_server: Server) {
// //     this.logger.log('LeMans Voice Gateway Initialized');
// //   }

// //   handleConnection(client: Socket) {
// //     this.logger.log(`Client connected: ${client.id}`);
// //     void this.startPrewarm(client);
// //   }

// //   handleDisconnect(client: Socket) {
// //     this.logger.log(`Client disconnected: ${client.id}`);
// //     this.clearPrewarmState(client.id);
// //     this.clearSilenceTimer(client.id);
// //     this.voiceService.closeSession(client.id);
// //   }

// //   // ─── Session lifecycle ────────────────────────────────────────────────────

// //   @SubscribeMessage('start-session')
// //   async handleStartSession(@ConnectedSocket() client: Socket) {
// //     const sessionId = client.id;
// //     this.logger.log(`[VoiceGateway] Starting session: ${sessionId}`);

// //     try {
// //       let state = this.prewarmStates.get(sessionId);

// //       if (!state) {
// //         await this.startPrewarm(client);
// //         state = this.prewarmStates.get(sessionId);
// //       }

// //       if (state) {
// //         try {
// //           await state.promise;
// //           if (state.ready) {
// //             this.clearPrewarmState(sessionId);
// //             client.emit('session-started', { sessionId });
// //             this.voiceService.triggerGreeting(sessionId);
// //             return;
// //           }
// //         } catch {
// //           // fall through
// //         }
// //         this.clearPrewarmState(sessionId);
// //       }

// //       // Fallback direct creation
// //       await this.voiceService.createRealtimeSession(
// //         sessionId,
// //         this.buildEventForwarder(client),
// //       );
// //       client.emit('session-started', { sessionId });
// //       this.voiceService.triggerGreeting(sessionId);
// //     } catch (err) {
// //       this.logger.error(`[VoiceGateway] Failed to start session: ${err.message}`);
// //       client.emit('realtime-error', {
// //         error: { message: 'Failed to connect to AI service' },
// //       });
// //     }
// //   }

// //   @SubscribeMessage('audio-chunk')
// //   handleAudioChunk(
// //     @ConnectedSocket() client: Socket,
// //     @MessageBody() data: { audio: string },
// //   ) {
// //     this.voiceService.sendAudio(client.id, data.audio);
// //   }

// //   @SubscribeMessage('end-session')
// //   handleEndSession(@ConnectedSocket() client: Socket) {
// //     this.logger.log(`[VoiceGateway] Ending session: ${client.id}`);
// //     this.clearPrewarmState(client.id);
// //     this.clearSilenceTimer(client.id);
// //     this.voiceService.closeSession(client.id);
// //     client.emit('session-closed', {});
// //   }

// //   // ─── Silence timer management ─────────────────────────────────────────────

// //   private startSilenceTimer(client: Socket): void {
// //     this.clearSilenceTimer(client.id);
// //     const timer = setTimeout(() => {
// //       this.logger.log(
// //         `[VoiceGateway] Silence timeout for ${client.id} — notifying service`,
// //       );
// //       this.voiceService.handleSilenceTimeout(client.id);
// //     }, this.SILENCE_TIMEOUT_MS);
// //     this.silenceTimers.set(client.id, timer);
// //   }

// //   private clearSilenceTimer(sessionId: string): void {
// //     const t = this.silenceTimers.get(sessionId);
// //     if (t) {
// //       clearTimeout(t);
// //       this.silenceTimers.delete(sessionId);
// //     }
// //   }

// //   // ─── Prewarm helpers ──────────────────────────────────────────────────────

// //   private async startPrewarm(client: Socket): Promise<void> {
// //     const sessionId = client.id;
// //     const existing = this.prewarmStates.get(sessionId);
// //     if (existing) return existing.promise;

// //     let state: PrewarmState;
// //     const promise = this.voiceService
// //       .createRealtimeSession(sessionId, this.buildEventForwarder(client))
// //       .then(() => {
// //         state.ready = true;
// //         state.failed = false;
// //         this.logger.log(`[VoiceGateway] Prewarm ready: ${sessionId}`);
// //       })
// //       .catch((err: Error) => {
// //         state.ready = false;
// //         state.failed = true;
// //         this.logger.warn(
// //           `[VoiceGateway] Prewarm failed for ${sessionId}: ${err.message}`,
// //         );
// //         throw err;
// //       });

// //     const ttlTimer = setTimeout(() => {
// //       const current = this.prewarmStates.get(sessionId);
// //       if (!current) return;
// //       this.logger.log(
// //         `[VoiceGateway] Prewarm TTL expired for ${sessionId}; closing idle session`,
// //       );
// //       this.clearPrewarmState(sessionId);
// //       this.voiceService.closeSession(sessionId);
// //     }, this.prewarmTtlMs);

// //     state = { promise, ready: false, failed: false, ttlTimer };
// //     this.prewarmStates.set(sessionId, state);
// //     return promise;
// //   }

// //   private clearPrewarmState(sessionId: string): void {
// //     const state = this.prewarmStates.get(sessionId);
// //     if (!state) return;
// //     clearTimeout(state.ttlTimer);
// //     this.prewarmStates.delete(sessionId);
// //   }

// //   // ─── Event forwarder ──────────────────────────────────────────────────────

// //   private buildEventForwarder(client: Socket): (event: any) => void {
// //     return (event: any) => {
// //       switch (event.type) {
// //         case 'audio-delta':
// //           client.emit('audio-delta', { delta: event.delta });
// //           break;

// //         case 'audio-done':
// //           // Agent finished speaking — start the silence countdown
// //           this.startSilenceTimer(client);
// //           client.emit('audio-done', {});
// //           break;

// //         case 'transcript-delta':
// //           client.emit('transcript-delta', { delta: event.delta });
// //           break;

// //         case 'transcript-done':
// //           client.emit('transcript-done', { transcript: event.transcript });
// //           break;

// //         case 'user-transcript':
// //           // User spoke — cancel silence timer
// //           this.clearSilenceTimer(client.id);
// //           client.emit('user-transcript', { transcript: event.transcript });
// //           break;

// //         case 'speech-started':
// //           this.clearSilenceTimer(client.id);
// //           client.emit('speech-started', {});
// //           break;

// //         case 'transfer-initiated':
// //           client.emit('transfer-initiated', event.data);
// //           break;

// //         case 'lead-saved':
// //           client.emit('lead-saved', event.data);
// //           break;

// //         case 'error':
// //           client.emit('realtime-error', { error: event.error });
// //           break;

// //         case 'session-closed':
// //           client.emit('session-closed', {});
// //           break;
// //       }
// //     };
// //   }
// // }
// import {
//   WebSocketGateway,
//   WebSocketServer,
//   SubscribeMessage,
//   MessageBody,
//   ConnectedSocket,
//   OnGatewayInit,
//   OnGatewayConnection,
//   OnGatewayDisconnect,
// } from '@nestjs/websockets';
// import { Server, Socket } from 'socket.io';
// import { Logger } from '@nestjs/common';
// import { VoiceService } from './voice.service';

// interface PrewarmState {
//   promise: Promise<void>;
//   ready: boolean;
//   failed: boolean;
//   ttlTimer: ReturnType<typeof setTimeout>;
// }

// @WebSocketGateway({
//   cors: {
//     origin: '*',
//   },
// })
// export class VoiceGateway
//   implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
// {
//   @WebSocketServer() server: Server;
//   private logger: Logger = new Logger('VoiceGateway');
//   private readonly prewarmTtlMs = 60_000;
//   private readonly prewarmStates = new Map<string, PrewarmState>();

//   // Silence timer per session: fires after the CLIENT finishes playing all
//   // queued audio + SILENCE_TIMEOUT_MS of no speech detected.
//   private readonly silenceTimers = new Map<
//     string,
//     ReturnType<typeof setTimeout>
//   >();
//   private readonly SILENCE_TIMEOUT_MS = 5_000;

//   constructor(private readonly voiceService: VoiceService) {}

//   afterInit(_server: Server) {
//     this.logger.log('LeMans Voice Gateway Initialized');
//   }

//   handleConnection(client: Socket) {
//     this.logger.log(`Client connected: ${client.id}`);
//     void this.startPrewarm(client);
//   }

//   handleDisconnect(client: Socket) {
//     this.logger.log(`Client disconnected: ${client.id}`);
//     this.clearPrewarmState(client.id);
//     this.clearSilenceTimer(client.id);
//     this.voiceService.closeSession(client.id);
//   }

//   // ─── Session lifecycle ────────────────────────────────────────────────────

//   @SubscribeMessage('start-session')
//   async handleStartSession(@ConnectedSocket() client: Socket) {
//     const sessionId = client.id;
//     this.logger.log(`[VoiceGateway] Starting session: ${sessionId}`);

//     try {
//       let state = this.prewarmStates.get(sessionId);

//       if (!state) {
//         await this.startPrewarm(client);
//         state = this.prewarmStates.get(sessionId);
//       }

//       if (state) {
//         try {
//           await state.promise;
//           if (state.ready) {
//             this.clearPrewarmState(sessionId);
//             client.emit('session-started', { sessionId });
//             this.voiceService.triggerGreeting(sessionId);
//             return;
//           }
//         } catch {
//           // fall through
//         }
//         this.clearPrewarmState(sessionId);
//       }

//       // Fallback direct creation
//       await this.voiceService.createRealtimeSession(
//         sessionId,
//         this.buildEventForwarder(client),
//       );
//       client.emit('session-started', { sessionId });
//       this.voiceService.triggerGreeting(sessionId);
//     } catch (err) {
//       this.logger.error(`[VoiceGateway] Failed to start session: ${err.message}`);
//       client.emit('realtime-error', {
//         error: { message: 'Failed to connect to AI service' },
//       });
//     }
//   }

//   @SubscribeMessage('audio-chunk')
//   handleAudioChunk(
//     @ConnectedSocket() client: Socket,
//     @MessageBody() data: { audio: string },
//   ) {
//     this.voiceService.sendAudio(client.id, data.audio);
//   }

//   @SubscribeMessage('end-session')
//   handleEndSession(@ConnectedSocket() client: Socket) {
//     this.logger.log(`[VoiceGateway] Ending session: ${client.id}`);
//     this.clearPrewarmState(client.id);
//     this.clearSilenceTimer(client.id);
//     this.voiceService.closeSession(client.id);
//     client.emit('session-closed', {});
//   }

//   /**
//    * The client emits 'playback-done' once the Web Audio API has finished
//    * playing every queued PCM chunk AND ElevenLabs has signalled isFinal.
//    * This is the correct moment to start the silence countdown — the bot
//    * has genuinely stopped speaking from the caller's perspective.
//    */
//   @SubscribeMessage('playback-done')
//   handlePlaybackDone(@ConnectedSocket() client: Socket) {
//     this.logger.debug(
//       `[VoiceGateway] Playback done for ${client.id} — starting silence timer`,
//     );
//     this.startSilenceTimer(client);
//   }

//   // ─── Silence timer management ─────────────────────────────────────────────

//   private startSilenceTimer(client: Socket): void {
//     this.clearSilenceTimer(client.id);
//     const timer = setTimeout(() => {
//       this.logger.log(
//         `[VoiceGateway] Silence timeout for ${client.id} — notifying service`,
//       );
//       this.voiceService.handleSilenceTimeout(client.id);
//     }, this.SILENCE_TIMEOUT_MS);
//     this.silenceTimers.set(client.id, timer);
//   }

//   private clearSilenceTimer(sessionId: string): void {
//     const t = this.silenceTimers.get(sessionId);
//     if (t) {
//       clearTimeout(t);
//       this.silenceTimers.delete(sessionId);
//     }
//   }

//   // ─── Prewarm helpers ──────────────────────────────────────────────────────

//   private async startPrewarm(client: Socket): Promise<void> {
//     const sessionId = client.id;
//     const existing = this.prewarmStates.get(sessionId);
//     if (existing) return existing.promise;

//     let state: PrewarmState;
//     const promise = this.voiceService
//       .createRealtimeSession(sessionId, this.buildEventForwarder(client))
//       .then(() => {
//         state.ready = true;
//         state.failed = false;
//         this.logger.log(`[VoiceGateway] Prewarm ready: ${sessionId}`);
//       })
//       .catch((err: Error) => {
//         state.ready = false;
//         state.failed = true;
//         this.logger.warn(
//           `[VoiceGateway] Prewarm failed for ${sessionId}: ${err.message}`,
//         );
//         throw err;
//       });

//     const ttlTimer = setTimeout(() => {
//       const current = this.prewarmStates.get(sessionId);
//       if (!current) return;
//       this.logger.log(
//         `[VoiceGateway] Prewarm TTL expired for ${sessionId}; closing idle session`,
//       );
//       this.clearPrewarmState(sessionId);
//       this.voiceService.closeSession(sessionId);
//     }, this.prewarmTtlMs);

//     state = { promise, ready: false, failed: false, ttlTimer };
//     this.prewarmStates.set(sessionId, state);
//     return promise;
//   }

//   private clearPrewarmState(sessionId: string): void {
//     const state = this.prewarmStates.get(sessionId);
//     if (!state) return;
//     clearTimeout(state.ttlTimer);
//     this.prewarmStates.delete(sessionId);
//   }

//   // ─── Event forwarder ──────────────────────────────────────────────────────

//   private buildEventForwarder(client: Socket): (event: any) => void {
//     return (event: any) => {
//       switch (event.type) {
//         case 'audio-delta':
//           client.emit('audio-delta', { delta: event.delta });
//           break;

//         case 'audio-done':
//           // Forward to client so it knows ElevenLabs is done streaming for
//           // this turn. The client will emit 'playback-done' back to us once
//           // the Web Audio queue has fully drained — that's when we start the
//           // silence timer (see handlePlaybackDone above).
//           client.emit('audio-done', {});
//           break;

//         case 'transcript-delta':
//           client.emit('transcript-delta', { delta: event.delta });
//           break;

//         case 'transcript-done':
//           client.emit('transcript-done', { transcript: event.transcript });
//           break;

//         case 'user-transcript':
//           // User spoke — cancel silence timer immediately
//           this.clearSilenceTimer(client.id);
//           client.emit('user-transcript', { transcript: event.transcript });
//           break;

//         case 'speech-started':
//           // Barge-in detected — cancel silence timer immediately
//           this.clearSilenceTimer(client.id);
//           client.emit('speech-started', {});
//           break;

//         case 'transfer-initiated':
//           client.emit('transfer-initiated', event.data);
//           break;

//         case 'lead-saved':
//           client.emit('lead-saved', event.data);
//           break;

//         case 'error':
//           client.emit('realtime-error', { error: event.error });
//           break;

//         case 'session-closed':
//           client.emit('session-closed', {});
//           break;
//       }
//     };
//   }
// }
import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
  OnGatewayInit,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger } from '@nestjs/common';
import { VoiceService } from './voice.service';

interface PrewarmState {
  promise: Promise<void>;
  ready: boolean;
  failed: boolean;
  ttlTimer: ReturnType<typeof setTimeout>;
}

@WebSocketGateway({
  cors: {
    origin: '*',
  },
})
export class VoiceGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer() server: Server;
  private logger: Logger = new Logger('VoiceGateway');
  private readonly prewarmTtlMs = 60_000;
  private readonly prewarmStates = new Map<string, PrewarmState>();

  // Silence timer per session: fires after the CLIENT finishes playing all
  // queued audio + the appropriate silence timeout based on turn type.
  private readonly silenceTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();

  /**
   * SILENCE_TIMEOUT_CONVERSATION_MS — used for every bot turn where the bot
   * is asking a question and genuinely needs to wait for a caller reply.
   * 10 seconds gives callers time to think and respond naturally.
   */
  private readonly SILENCE_TIMEOUT_CONVERSATION_MS = 10_000;

  /**
   * SILENCE_TIMEOUT_WRAPUP_MS — used only for the final farewell/confirmation
   * turn (after save_lead or transfer_call has been dispatched). The bot is
   * just closing out the call, so a shorter wait is fine.
   */
  private readonly SILENCE_TIMEOUT_WRAPUP_MS = 5_000;

  /**
   * Tracks whether the most recently completed bot turn was a wrap-up turn
   * (i.e. save_lead or transfer_call was already dispatched). Set via the
   * 'response-type' event from VoiceService and consumed by handlePlaybackDone.
   */
  private readonly wrapUpFlags = new Map<string, boolean>();

  constructor(private readonly voiceService: VoiceService) {}

  afterInit(_server: Server) {
    this.logger.log('LeMans Voice Gateway Initialized');
  }

  handleConnection(client: Socket) {
    this.logger.log(`Client connected: ${client.id}`);
    void this.startPrewarm(client);
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected: ${client.id}`);
    this.clearPrewarmState(client.id);
    this.clearSilenceTimer(client.id);
    this.wrapUpFlags.delete(client.id);
    this.voiceService.closeSession(client.id);
  }

  // ─── Session lifecycle ────────────────────────────────────────────────────

  @SubscribeMessage('start-session')
  async handleStartSession(@ConnectedSocket() client: Socket) {
    const sessionId = client.id;
    this.logger.log(`[VoiceGateway] Starting session: ${sessionId}`);

    try {
      let state = this.prewarmStates.get(sessionId);

      if (!state) {
        await this.startPrewarm(client);
        state = this.prewarmStates.get(sessionId);
      }

      if (state) {
        try {
          await state.promise;
          if (state.ready) {
            this.clearPrewarmState(sessionId);
            client.emit('session-started', { sessionId });
            this.voiceService.triggerGreeting(sessionId);
            return;
          }
        } catch {
          // fall through
        }
        this.clearPrewarmState(sessionId);
      }

      // Fallback direct creation
      await this.voiceService.createRealtimeSession(
        sessionId,
        this.buildEventForwarder(client),
      );
      client.emit('session-started', { sessionId });
      this.voiceService.triggerGreeting(sessionId);
    } catch (err) {
      this.logger.error(`[VoiceGateway] Failed to start session: ${err.message}`);
      client.emit('realtime-error', {
        error: { message: 'Failed to connect to AI service' },
      });
    }
  }

  @SubscribeMessage('audio-chunk')
  handleAudioChunk(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { audio: string },
  ) {
    this.voiceService.sendAudio(client.id, data.audio);
  }

  @SubscribeMessage('end-session')
  handleEndSession(@ConnectedSocket() client: Socket) {
    this.logger.log(`[VoiceGateway] Ending session: ${client.id}`);
    this.clearPrewarmState(client.id);
    this.clearSilenceTimer(client.id);
    this.wrapUpFlags.delete(client.id);
    this.voiceService.closeSession(client.id);
    client.emit('session-closed', {});
  }

  /**
   * The client emits 'playback-done' once the Web Audio API has finished
   * playing every queued PCM chunk AND ElevenLabs has signalled isFinal.
   * This is the correct moment to start the silence countdown — the bot
   * has genuinely stopped speaking from the caller's perspective.
   *
   * The timeout duration depends on whether this was a wrap-up turn:
   *   - Normal conversation turn  → 10 seconds  (caller needs thinking time)
   *   - Wrap-up / farewell turn   →  5 seconds  (just confirming, no answer needed)
   */
  @SubscribeMessage('playback-done')
  handlePlaybackDone(@ConnectedSocket() client: Socket) {
    const isWrapUp = this.wrapUpFlags.get(client.id) ?? false;
    const timeoutMs = isWrapUp
      ? this.SILENCE_TIMEOUT_WRAPUP_MS
      : this.SILENCE_TIMEOUT_CONVERSATION_MS;

    this.logger.debug(
      `[VoiceGateway] Playback done for ${client.id} — starting ${isWrapUp ? 'wrap-up' : 'conversation'} silence timer (${timeoutMs}ms)`,
    );

    this.startSilenceTimer(client, timeoutMs);
  }

  // ─── Silence timer management ─────────────────────────────────────────────

  private startSilenceTimer(client: Socket, timeoutMs: number): void {
    this.clearSilenceTimer(client.id);
    const timer = setTimeout(() => {
      this.logger.log(
        `[VoiceGateway] Silence timeout for ${client.id} — notifying service`,
      );
      this.voiceService.handleSilenceTimeout(client.id);
    }, timeoutMs);
    this.silenceTimers.set(client.id, timer);
  }

  private clearSilenceTimer(sessionId: string): void {
    const t = this.silenceTimers.get(sessionId);
    if (t) {
      clearTimeout(t);
      this.silenceTimers.delete(sessionId);
    }
  }

  // ─── Prewarm helpers ──────────────────────────────────────────────────────

  private async startPrewarm(client: Socket): Promise<void> {
    const sessionId = client.id;
    const existing = this.prewarmStates.get(sessionId);
    if (existing) return existing.promise;

    let state: PrewarmState;
    const promise = this.voiceService
      .createRealtimeSession(sessionId, this.buildEventForwarder(client))
      .then(() => {
        state.ready = true;
        state.failed = false;
        this.logger.log(`[VoiceGateway] Prewarm ready: ${sessionId}`);
      })
      .catch((err: Error) => {
        state.ready = false;
        state.failed = true;
        this.logger.warn(
          `[VoiceGateway] Prewarm failed for ${sessionId}: ${err.message}`,
        );
        throw err;
      });

    const ttlTimer = setTimeout(() => {
      const current = this.prewarmStates.get(sessionId);
      if (!current) return;
      this.logger.log(
        `[VoiceGateway] Prewarm TTL expired for ${sessionId}; closing idle session`,
      );
      this.clearPrewarmState(sessionId);
      this.voiceService.closeSession(sessionId);
    }, this.prewarmTtlMs);

    state = { promise, ready: false, failed: false, ttlTimer };
    this.prewarmStates.set(sessionId, state);
    return promise;
  }

  private clearPrewarmState(sessionId: string): void {
    const state = this.prewarmStates.get(sessionId);
    if (!state) return;
    clearTimeout(state.ttlTimer);
    this.prewarmStates.delete(sessionId);
  }

  // ─── Event forwarder ──────────────────────────────────────────────────────

  private buildEventForwarder(client: Socket): (event: any) => void {
    return (event: any) => {
      switch (event.type) {
        case 'audio-delta':
          client.emit('audio-delta', { delta: event.delta });
          break;

        case 'audio-done':
          // Forward to client so it knows ElevenLabs is done streaming for
          // this turn. The client will emit 'playback-done' back to us once
          // the Web Audio queue has fully drained — that's when we start the
          // silence timer (see handlePlaybackDone above).
          client.emit('audio-done', {});
          break;

        case 'response-type':
          // VoiceService tells us whether the turn that just completed was a
          // wrap-up turn (save_lead / transfer_call already dispatched). We
          // store the flag so handlePlaybackDone can read it when the client
          // signals that audio playback has actually finished.
          this.wrapUpFlags.set(client.id, event.isWrapUp === true);
          this.logger.debug(
            `[VoiceGateway] response-type for ${client.id}: isWrapUp=${event.isWrapUp}`,
          );
          break;

        case 'transcript-delta':
          client.emit('transcript-delta', { delta: event.delta });
          break;

        case 'transcript-done':
          client.emit('transcript-done', { transcript: event.transcript });
          break;

        case 'user-transcript':
          // User spoke — cancel silence timer immediately
          this.clearSilenceTimer(client.id);
          client.emit('user-transcript', { transcript: event.transcript });
          break;

        case 'speech-started':
          // Barge-in detected — cancel silence timer immediately
          this.clearSilenceTimer(client.id);
          client.emit('speech-started', {});
          break;

        case 'transfer-initiated':
          client.emit('transfer-initiated', event.data);
          break;

        case 'lead-saved':
          client.emit('lead-saved', event.data);
          break;

        case 'error':
          client.emit('realtime-error', { error: event.error });
          break;

        case 'session-closed':
          client.emit('session-closed', {});
          break;
      }
    };
  }
}