import { EventEmitter } from 'node:events';
import { ConfigService } from '@nestjs/config';
import WebSocket from 'ws';
import { LeadCaptureService } from './lead-capture.service';
import { VoiceService } from './voice.service';

jest.mock('ws', () => {
  const { EventEmitter } =
    jest.requireActual<typeof import('node:events')>('node:events');
  class FakeSocket extends EventEmitter {
    static OPEN = 1;
    static CONNECTING = 0;
    static instances: FakeSocket[] = [];
    readyState = 1;
    send = jest.fn();
    close = jest.fn(() => {
      this.readyState = 3;
      this.emit('close');
    });
    constructor() {
      super();
      FakeSocket.instances.push(this);
    }
  }
  return { __esModule: true, default: FakeSocket };
});

type FakeSocket = EventEmitter & { send: jest.Mock; close: jest.Mock };
const sockets = WebSocket as unknown as { instances: FakeSocket[] };

describe('VoiceService lead lifecycle', () => {
  let service: VoiceService;
  let capture: {
    startSession: jest.Mock;
    appendTranscript: jest.Mock;
    captureLead: jest.Mock;
    finalizeSession: jest.Mock;
  };
  let events: jest.Mock;

  beforeEach(() => {
    jest.useFakeTimers();
    sockets.instances = [];
    capture = {
      startSession: jest.fn(),
      appendTranscript: jest.fn(),
      captureLead: jest.fn().mockResolvedValue({ capture_status: 'complete' }),
      finalizeSession: jest.fn().mockResolvedValue(undefined),
    };
    events = jest.fn();
    service = new VoiceService(
      { get: () => 'test-key' } as unknown as ConfigService,
      capture as unknown as LeadCaptureService,
    );
  });

  afterEach(() => jest.useRealTimers());

  async function connect() {
    const ready = service.createRealtimeSession('browser', events);
    const ws = sockets.instances.at(-1)!;
    ws.emit('open');
    ws.emit(
      'message',
      Buffer.from(JSON.stringify({ type: 'session.started' })),
    );
    await ready;
    return ws;
  }

  it('starts capture only when the user starts the call, not during prewarming', async () => {
    await connect();
    expect(capture.startSession).not.toHaveBeenCalled();
    service.triggerGreeting('browser');
    expect(capture.startSession).toHaveBeenCalledWith(
      'browser',
      'unknown',
      expect.any(Object),
    );
  });

  it('forwards both speakers and executes later delegations to retain corrections', async () => {
    const ws = await connect();
    service.triggerGreeting('browser');
    for (const event of [
      {
        type: 'session.output_transcript.delta',
        delta: 'What is your name?',
        start_ms: 100,
        end_ms: 500,
      },
      {
        type: 'session.input_transcript.delta',
        delta: 'Sarah',
        start_ms: 600,
        end_ms: 900,
      },
    ])
      ws.emit('message', Buffer.from(JSON.stringify(event)));
    for (let index = 0; index < 2; index++) {
      ws.emit(
        'message',
        Buffer.from(
          JSON.stringify({
            type: 'session.delegation.created',
            delegation: { id: `d${index}` },
          }),
        ),
      );
      await Promise.resolve();
      await Promise.resolve();
    }
    expect(capture.appendTranscript).toHaveBeenCalledWith(
      'browser',
      'assistant',
      'What is your name?',
      100,
      500,
    );
    expect(capture.appendTranscript).toHaveBeenCalledWith(
      'browser',
      'user',
      'Sarah',
      600,
      900,
    );
    expect(capture.captureLead).toHaveBeenCalledTimes(2);
    expect(
      ws.send.mock.calls
        .map(([data]) => JSON.parse(data))
        .filter((event) => event.type === 'session.commentary.append'),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ delegation_id: 'd0' }),
        expect.objectContaining({ delegation_id: 'd1' }),
      ]),
    );
  });

  it('drains final transcripts and emits session-closed only after final persistence', async () => {
    const ws = await connect();
    service.triggerGreeting('browser');
    let saved!: () => void;
    capture.finalizeSession.mockReturnValue(
      new Promise<void>((resolve) => {
        saved = resolve;
      }),
    );
    const first = service.closeSession('browser');
    expect(service.closeSession('browser')).toBe(first);
    ws.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          type: 'session.input_transcript.delta',
          delta: 'One last detail.',
        }),
      ),
    );
    await jest.advanceTimersByTimeAsync(750);
    expect(capture.appendTranscript).toHaveBeenCalledWith(
      'browser',
      'user',
      'One last detail.',
      undefined,
      undefined,
    );
    expect(capture.finalizeSession).toHaveBeenCalledTimes(1);
    expect(events).not.toHaveBeenCalledWith({ type: 'session-closed' });
    saved();
    await first;
    expect(events).toHaveBeenCalledWith({ type: 'session-closed' });
  });

  it('finalizes on provider disconnect without a delegation', async () => {
    const ws = await connect();
    service.triggerGreeting('browser');
    ws.emit('close');
    await jest.advanceTimersByTimeAsync(0);
    expect(capture.finalizeSession).toHaveBeenCalledWith('browser');
    expect(events).toHaveBeenCalledWith({ type: 'session-closed' });
  });
});
