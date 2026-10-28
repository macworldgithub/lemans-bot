import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Server, Socket } from 'socket.io';
import type { SpeakerVerdict } from './speaker-lock/speaker-lock';

export type TranscriptRole = 'user' | 'bot';
export type TranscriptKind =
  'start' | 'delta' | 'final' | 'interrupted' | 'speaker';
export type CallSource = 'web' | 'phone';

/**
 * One normalized transcript event. `id` is the OpenAI conversation item id,
 * so a user line created at speech start is filled in later by its deltas,
 * keeping lines in true conversation order.
 */
export interface TranscriptEvent {
  callId: string;
  role: TranscriptRole;
  id: string;
  kind: TranscriptKind;
  text?: string;
  /** Present on kind 'speaker': speaker-lock verdict for a caller turn. */
  speaker?: SpeakerVerdict;
  ts: number;
}

interface TranscriptLine {
  id: string;
  role: TranscriptRole;
  text: string;
  final: boolean;
  interrupted: boolean;
  speaker: SpeakerVerdict | null;
  ts: number;
}

interface CallTranscript {
  callId: string;
  source: CallSource;
  callerNumber: string;
  startedAt: number;
  endedAt: number | null;
  lines: TranscriptLine[];
}

/**
 * Live transcript hub on the `/monitor` namespace.
 * Every user/bot line from web and phone calls is pushed here the moment
 * OpenAI emits it (no batching), so the monitor page shows text in real time.
 */
@WebSocketGateway({
  namespace: '/monitor',
  cors: { origin: '*' },
})
export class LiveTranscriptGateway implements OnGatewayConnection {
  @WebSocketServer() server: Server;
  private readonly logger = new Logger(LiveTranscriptGateway.name);
  private readonly calls = new Map<string, CallTranscript>();
  private readonly MAX_ENDED_CALLS = 20;

  constructor(private readonly config: ConfigService) {}

  handleConnection(client: Socket) {
    this.logger.log(`Monitor connected: ${client.id}`);
    client.emit('snapshot', { calls: [...this.calls.values()] });
  }

  // ─── Publishers ───────────────────────────────────────────────────────────

  callStarted(
    callId: string,
    source: CallSource,
    callerNumber = 'unknown',
  ): void {
    const call: CallTranscript = {
      callId,
      source,
      callerNumber,
      startedAt: Date.now(),
      endedAt: null,
      lines: [],
    };
    this.calls.set(callId, call);
    this.server?.emit('call-started', { ...call, lines: undefined });
  }

  callEnded(callId: string): void {
    const call = this.calls.get(callId);
    if (!call || call.endedAt) return;
    call.endedAt = Date.now();
    this.server?.emit('call-ended', { callId, endedAt: call.endedAt });
    this.pruneEndedCalls();
  }

  /** Applies the event to the stored transcript and broadcasts it. */
  publish(event: Omit<TranscriptEvent, 'ts'>): TranscriptEvent {
    const full: TranscriptEvent = { ...event, ts: Date.now() };
    const call = this.calls.get(event.callId);
    if (call) this.applyToCall(call, full);
    this.server?.emit('transcript', full);
    return full;
  }

  private applyToCall(call: CallTranscript, e: TranscriptEvent): void {
    let line = call.lines.find((l) => l.id === e.id && l.role === e.role);
    if (!line) {
      line = {
        id: e.id,
        role: e.role,
        text: '',
        final: false,
        interrupted: false,
        speaker: null,
        ts: e.ts,
      };
      call.lines.push(line);
    }
    switch (e.kind) {
      case 'delta':
        line.text += e.text ?? '';
        break;
      case 'final':
        line.text = e.text ?? line.text;
        line.final = true;
        break;
      case 'interrupted':
        line.interrupted = true;
        break;
      case 'speaker':
        line.speaker = e.speaker ?? null;
        break;
    }
  }

  private pruneEndedCalls(): void {
    const ended = [...this.calls.values()]
      .filter((c) => c.endedAt)
      .sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));
    while (ended.length > this.MAX_ENDED_CALLS) {
      this.calls.delete(ended.shift()!.callId);
    }
  }

  // ─── OpenAI session config ────────────────────────────────────────────────

  /**
   * `session.audio.input.transcription` block for the OpenAI Realtime API.
   * gpt-live-transcribe streams `...input_audio_transcription.delta` events,
   * which is what lets the caller's words appear without waiting for the
   * full turn.
   */
  getInputTranscriptionConfig(): Record<string, string> {
    const cfg: Record<string, string> = {
      model:
        this.config.get<string>('OPENAI_TRANSCRIBE_MODEL') ??
        'gpt-live-transcribe',
    };
    const language = this.config.get<string>('OPENAI_TRANSCRIBE_LANGUAGE');
    if (language) cfg.language = language;
    cfg.prompt =
      this.config.get<string>('OPENAI_TRANSCRIBE_PROMPT') ??
      'Phone call to Le Mans Entertainment in Australia about go-karts, karting, VR, laser tag, mini golf, arcade, kids parties, bucks and hens parties, corporate events, bookings and prices.';
    return cfg;
  }
}
