import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import { ConfigService } from '@nestjs/config';
import WebSocket from 'ws';
import OpenAI from 'openai';
import { SandwichOptions, SandwichService } from './sandwich.service';

jest.mock('ws', () => {
  const { EventEmitter } =
    jest.requireActual<typeof import('node:events')>('node:events');
  class Socket extends EventEmitter {
    static OPEN = 1;
    static CONNECTING = 0;
    static instances: Socket[] = [];
    readyState = 0;
    bufferedAmount = 0;
    send = jest.fn((_data: unknown, callback?: (error?: Error) => void) =>
      callback?.(),
    );
    close = jest.fn(() => {
      this.readyState = 3;
      this.emit('close');
    });
    terminate = this.close;
    constructor(
      public url: URL,
      public options: any,
    ) {
      super();
      Socket.instances.push(this);
    }
  }
  return { __esModule: true, default: Socket };
});
jest.mock('openai', () => ({ __esModule: true, default: jest.fn() }));
type Socket = EventEmitter & {
  url: URL;
  options: any;
  readyState: number;
  bufferedAmount: number;
  send: jest.Mock;
  close: jest.Mock;
};
const sockets = WebSocket as unknown as { instances: Socket[] };
const message = (ws: Socket, event: object) =>
  ws.emit('message', Buffer.from(JSON.stringify(event)));
async function settle() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe('Sandwich streaming pipeline', () => {
  let service: SandwichService;
  let create: jest.Mock;
  let options: SandwichOptions;
  let stt: Socket;
  let tts: Socket;
  let values: Record<string, string>;
  beforeEach(() => {
    jest.useFakeTimers();
    sockets.instances = [];
    create = jest.fn().mockImplementation(async () =>
      (async function* () {
        yield { type: 'response.output_text.delta', delta: 'Hello there. ' };
        yield { type: 'response.completed' };
      })(),
    );
    (OpenAI as unknown as jest.Mock).mockImplementation(() => ({
      responses: { create },
    }));
    values = {
      OPENAI_API_KEY: 'test',
      ELEVENLABS_API_KEY: 'test',
      ELEVENLABS_VOICE_ID: 'voice',
      DeepGram_API_Key: 'legacy-key',
    };
    service = new SandwichService({
      get: (key: string) => values[key],
    } as unknown as ConfigService);
    options = {
      inputEncoding: 'linear16',
      inputRate: 24000,
      outputFormat: 'pcm_24000',
      instructions: 'Chloe',
      onEvent: jest.fn(),
      onTranscript: jest.fn(),
      captureLead: jest.fn().mockResolvedValue({ capture_status: 'complete' }),
    };
  });
  afterEach(async () => {
    await service.closeSession('call', false);
    jest.useRealTimers();
  });
  async function connect(custom = options) {
    const pending = service.createSession('call', custom);
    [stt, tts] = sockets.instances;
    stt.readyState = tts.readyState = 1;
    stt.emit('open');
    tts.emit('open');
    message(stt, { type: 'Connected' });
    await pending;
  }
  function turn(text = 'Can I book a party?', index = 0) {
    message(stt, {
      type: 'TurnInfo',
      event: 'EndOfTurn',
      transcript: text,
      turn_index: index,
      words: [{ end: 0.02 }],
    });
  }
  function context(): string {
    return tts.send.mock.calls
      .map(([data]) => JSON.parse(data))
      .find((event) => event.text === ' ').context_id;
  }
  it.each([
    { model: 'gpt-6-luna', configured: undefined, expected: 'none' },
    { model: 'gpt-6-luna', configured: 'medium', expected: 'medium' },
    { model: 'gpt-4.1-mini', configured: undefined, expected: undefined },
  ])(
    'uses voice reasoning $expected for $model with override $configured',
    async ({ model, configured, expected }) => {
      values.OPENAI_VOICE_MODEL = model;
      if (configured) values.OPENAI_VOICE_REASONING_EFFORT = configured;
      await connect();
      turn();
      await settle();
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({ model }),
        expect.anything(),
      );
      expect(create.mock.calls[0][0].reasoning).toEqual(
        expected === undefined ? undefined : { effort: expected },
      );
      expect(tts.send).toHaveBeenCalled();
    },
  );
  it('requires Flux readiness and uses matching web and phone codecs with header auth', async () => {
    await connect({
      ...options,
      inputEncoding: 'mulaw',
      inputRate: 8000,
      outputFormat: 'ulaw_8000',
    });
    expect(stt.url.pathname).toBe('/v2/listen');
    expect(stt.url.searchParams.get('encoding')).toBe('mulaw');
    expect(stt.url.searchParams.get('sample_rate')).toBe('8000');
    expect(stt.options.headers.Authorization).toBe('Token legacy-key');
    expect(tts.url.searchParams.get('output_format')).toBe('ulaw_8000');
    expect(tts.url.searchParams.get('model_id')).toBe('eleven_flash_v2_5');
    expect(tts.url.toString()).not.toContain('test');
  });
  it('batches streaming audio into 80ms and keeps Flux alive with silence audio', async () => {
    let now = 0;
    const clock = jest.spyOn(performance, 'now').mockImplementation(() => now);
    await connect();
    for (let i = 0; i < 4; i++)
      service.sendAudio('call', Buffer.alloc(960).toString('base64'));
    expect(stt.send).toHaveBeenCalledWith(Buffer.alloc(3840));
    const count = stt.send.mock.calls.length;
    now = 240;
    await jest.advanceTimersByTimeAsync(240);
    expect(stt.send.mock.calls.length).toBeGreaterThan(count);
    clock.mockRestore();
  });
  it('preserves a 1.6 second phone startup burst while the STT socket drains', async () => {
    await connect({
      ...options,
      inputEncoding: 'mulaw',
      inputRate: 8000,
      outputFormat: 'ulaw_8000',
    });
    stt.send.mockImplementation((data: unknown) => {
      if (Buffer.isBuffer(data)) stt.bufferedAmount += data.length + 8;
    });
    const frames = Array.from({ length: 80 }, (_, index) =>
      Buffer.alloc(160, index),
    );
    for (const frame of frames)
      service.sendAudio('call', frame.toString('base64'));
    expect(service.hasSession('call')).toBe(true);
    expect(options.onEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'realtime-error' }),
    );
    // The next heartbeat resumes the retained frames after the network catches up.
    stt.bufferedAmount = 0;
    await jest.advanceTimersByTimeAsync(80);
    const sent = stt.send.mock.calls
      .map(([data]) => data)
      .filter(Buffer.isBuffer);
    expect(Buffer.concat(sent)).toEqual(Buffer.concat(frames));
    expect(sent.every((frame) => frame.length === 640)).toBe(true);
    // After the startup backlog, the next caller question must still reach the
    // model and produce speech instead of leaving a silent, dead connection.
    turn('What activities do you have for children?');
    await settle();
    message(tts, { context_id: context(), audio: 'AAA=' });
    expect(create).toHaveBeenCalledTimes(1);
    expect(options.onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'audio-delta' }),
    );
  });

  it('still closes a persistently blocked STT socket after the drain deadline', async () => {
    const clock = jest.spyOn(performance, 'now').mockReturnValue(1000);
    try {
      await connect({
        ...options,
        inputEncoding: 'mulaw',
        inputRate: 8000,
        outputFormat: 'ulaw_8000',
      });
      stt.bufferedAmount = 9000;
      service.sendAudio('call', Buffer.alloc(640).toString('base64'));
      expect(service.hasSession('call')).toBe(true);
      clock.mockReturnValue(6001);
      await jest.advanceTimersByTimeAsync(80);
      expect(options.onEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'realtime-error',
          error: expect.objectContaining({
            recoverable: false,
            code: 'STT_BACKPRESSURE',
          }),
        }),
      );
      expect(service.hasSession('call')).toBe(false);
    } finally {
      clock.mockRestore();
    }
  });
  it('keeps the retained STT input bounded when audio continues on a blocked network', async () => {
    await connect({
      ...options,
      inputEncoding: 'mulaw',
      inputRate: 8000,
      outputFormat: 'ulaw_8000',
    });
    stt.bufferedAmount = 9000;
    for (let i = 0; i < 101; i++)
      service.sendAudio('call', Buffer.alloc(160).toString('base64'));
    await settle();
    expect(options.onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'realtime-error',
        error: expect.objectContaining({
          code: 'INPUT_BUFFER_LIMIT',
          recoverable: false,
        }),
      }),
    );
    expect(service.hasSession('call')).toBe(false);
  });
  it('drains a five-second phone startup backlog and then restores the live input bound', async () => {
    await connect({
      ...options,
      inputEncoding: 'mulaw',
      inputRate: 8000,
      outputFormat: 'ulaw_8000',
    });
    stt.send.mockImplementation((data: unknown) => {
      if (Buffer.isBuffer(data)) stt.bufferedAmount += data.length + 8;
    });
    stt.bufferedAmount = 9000;
    const startup = Buffer.alloc(40960, 42);
    service.sendAudio('call', startup.toString('base64'), true);
    expect(service.hasSession('call')).toBe(true);
    for (let i = 0; i < 6; i++) {
      stt.bufferedAmount = 0;
      await jest.advanceTimersByTimeAsync(80);
    }
    const sent = stt.send.mock.calls
      .map(([data]) => data)
      .filter(Buffer.isBuffer);
    expect(Buffer.concat(sent)).toEqual(startup);
    expect(service.hasSession('call')).toBe(true);
    stt.bufferedAmount = 9000;
    service.sendAudio('call', Buffer.alloc(16160).toString('base64'));
    await settle();
    expect(service.hasSession('call')).toBe(false);
  });

  it('finishes the greeting before answering delayed speech from startup audio', async () => {
    await connect({
      ...options,
      inputEncoding: 'mulaw',
      inputRate: 8000,
      outputFormat: 'ulaw_8000',
    });
    service.sendAudio('call', Buffer.alloc(640).toString('base64'), true);
    service.speak('call', 'Hi, I am Chloe. How can I help?', true);
    const greeting = context();
    message(tts, { contextId: greeting, audio: 'AAA=' });
    message(stt, {
      type: 'TurnInfo',
      event: 'StartOfTurn',
      turn_index: 0,
      audio_window_end: 0.04,
    });
    message(stt, {
      type: 'TurnInfo',
      event: 'EndOfTurn',
      turn_index: 0,
      transcript: 'What activities do you have?',
      words: [{ end: 0.06 }],
    });
    await settle();
    expect(create).not.toHaveBeenCalled();
    expect(options.onEvent).not.toHaveBeenCalledWith({
      type: 'speech-started',
    });
    message(tts, { contextId: greeting, audio: 'AAA=', isFinal: true });
    await settle();
    expect(
      (options.onEvent as jest.Mock).mock.calls.filter(
        ([e]) => e.type === 'audio-delta' && e.turnId === greeting,
      ),
    ).toHaveLength(2);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0].input).toEqual([
      { role: 'assistant', content: 'Hi, I am Chloe. How can I help?' },
      { role: 'user', content: 'What activities do you have?' },
    ]);
  });

  it.each(['StartOfTurn', 'Update'])(
    'allows new speech during the greeting to interrupt via %s',
    async (event) => {
      await connect({
        ...options,
        inputEncoding: 'mulaw',
        inputRate: 8000,
        outputFormat: 'ulaw_8000',
      });
      service.sendAudio('call', Buffer.alloc(640).toString('base64'), true);
      service.speak('call', 'Hi, I am Chloe.', true);
      const greeting = context();
      if (event === 'Update')
        message(stt, {
          type: 'TurnInfo',
          event: 'StartOfTurn',
          audio_window_end: 0.04,
        });
      message(stt, {
        type: 'TurnInfo',
        event,
        audio_window_end: 0.2,
        transcript: 'Excuse me',
      });
      message(tts, { contextId: greeting, audio: 'AAA=' });
      expect(options.onEvent).toHaveBeenCalledWith({ type: 'speech-started' });
      expect(options.onEvent).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'audio-delta', turnId: greeting }),
      );
    },
  );

  it('does not start an introduction over an already active caller turn', async () => {
    await connect();
    message(stt, { type: 'TurnInfo', event: 'StartOfTurn', turn_index: 0 });
    service.speak('call', 'Hi, I am Chloe.', true);
    expect(tts.send).not.toHaveBeenCalled();
    turn('Can I book a party?');
    await settle();
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('waits for final socket writes before the transcript grace period on hangup', async () => {
    await connect({
      ...options,
      inputEncoding: 'mulaw',
      inputRate: 8000,
      outputFormat: 'ulaw_8000',
    });
    stt.bufferedAmount = 9000;
    service.sendAudio('call', Buffer.alloc(640).toString('base64'));
    stt.send.mockImplementation((_data: unknown, callback?: () => void) => {
      if (callback) setTimeout(callback, 100);
    });
    const close = service.closeSession('call');
    expect(service.closeSession('call')).toBe(close);
    await jest.advanceTimersByTimeAsync(1000);
    expect(service.hasSession('call')).toBe(true);
    expect(stt.send).not.toHaveBeenCalledWith(
      JSON.stringify({ type: 'CloseStream' }),
      expect.anything(),
    );
    stt.bufferedAmount = 0;
    await jest.advanceTimersByTimeAsync(250);
    turn('Actually, use the corrected number.');
    await jest.advanceTimersByTimeAsync(750);
    await close;
    expect(options.onTranscript).toHaveBeenCalledWith(
      'user',
      'Actually, use the corrected number. ',
    );
    expect(create).not.toHaveBeenCalled();
    expect(service.hasSession('call')).toBe(false);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('bounds hangup when a socket write callback never completes', async () => {
    await connect();
    let written: (() => void) | undefined;
    stt.send.mockImplementation((_data: unknown, callback?: () => void) => {
      written = callback;
    });
    const close = service.closeSession('call');
    await jest.advanceTimersByTimeAsync(6000);
    await close;
    const count = stt.send.mock.calls.length;
    written?.();
    expect(stt.send).toHaveBeenCalledTimes(count);
    expect(service.hasSession('call')).toBe(false);
    expect(jest.getTimerCount()).toBe(0);
  });
  it('releases a failed final write and preserves the last known partial transcript', async () => {
    await connect();
    message(stt, {
      type: 'TurnInfo',
      event: 'Update',
      transcript: 'Please use the other email',
    });
    stt.send.mockImplementation(
      (_data: unknown, callback?: (error?: Error) => void) =>
        callback?.(new Error('write failed')),
    );
    await service.closeSession('call');
    expect(service.hasSession('call')).toBe(false);
    expect(options.onTranscript).toHaveBeenCalledWith(
      'user',
      'Please use the other email ',
    );
    expect(create).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });
  it('streams LLM clauses to TTS before response completion and emits completion from TTS', async () => {
    let finish!: () => void;
    create.mockImplementation(async () =>
      (async function* () {
        yield { type: 'response.output_text.delta', delta: 'Hi there. ' };
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        yield { type: 'response.completed' };
      })(),
    );
    await connect();
    turn();
    await settle();
    expect(
      tts.send.mock.calls.map(([data]) => JSON.parse(data)),
    ).toContainEqual(
      expect.objectContaining({ text: 'Hi there. ', flush: true }),
    );
    const id = context();
    message(tts, { context_id: id, audio: 'AAA=' });
    expect(options.onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'audio-delta' }),
    );
    expect(options.onEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'audio-done' }),
    );
    finish();
    await settle();
    message(tts, { context_id: id, is_final: true });
    expect(options.onEvent).toHaveBeenCalledWith({
      type: 'audio-done',
      turnId: id,
    });
  });
  it('aborts generation on StartOfTurn, rejects old audio, and reuses both sockets', async () => {
    await connect();
    turn();
    await settle();
    const id = context();
    const signal = create.mock.calls[0][1].signal as AbortSignal;
    message(stt, { type: 'TurnInfo', event: 'StartOfTurn', turn_index: 1 });
    expect(signal.aborted).toBe(true);
    expect(tts.send).toHaveBeenCalledWith(
      JSON.stringify({ context_id: id, close_context: true }),
    );
    const count = (options.onEvent as jest.Mock).mock.calls.length;
    message(tts, { context_id: id, audio: 'AAA=', is_final: true });
    expect((options.onEvent as jest.Mock).mock.calls.length).toBe(count);
    turn('Actually, karting please.', 1);
    await settle();
    expect(create).toHaveBeenCalledTimes(2);
    expect(sockets.instances).toHaveLength(2);
  });
  it('handles transcript revisions and duplicate final turns without duplicate LLM or lead writes', async () => {
    await connect();
    message(stt, {
      type: 'TurnInfo',
      event: 'Update',
      transcript: 'My name is Sara',
    });
    message(stt, {
      type: 'TurnInfo',
      event: 'Update',
      transcript: 'My name is Sarah',
    });
    turn('My name is Sarah');
    turn('My name is Sarah');
    await settle();
    expect(options.onTranscript).toHaveBeenCalledWith(
      'user',
      'My name is Sarah ',
    );
    expect(create).toHaveBeenCalledTimes(1);
    expect(options.onEvent).toHaveBeenCalledWith({
      type: 'user-transcript',
      transcript: 'My name is Sarah',
    });
  });
  it('runs existing lead capture through a streamed tool round before confirming saving', async () => {
    create.mockImplementationOnce(async () =>
      (async function* () {
        yield {
          type: 'response.output_item.done',
          item: {
            type: 'function_call',
            name: 'capture_lead',
            call_id: 'lead1',
            arguments: '{}',
          },
        };
        yield { type: 'response.completed' };
      })(),
    );
    await connect();
    turn();
    await settle();
    expect(options.captureLead).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1][0].input).toContainEqual(
      expect.objectContaining({
        type: 'function_call_output',
        call_id: 'lead1',
      }),
    );
  });
  it('reports speech-end and detected-turn latency separately', async () => {
    await connect();
    service.sendAudio('call', Buffer.alloc(3840).toString('base64'));
    turn();
    await settle();
    message(tts, { context_id: context(), audio: 'AAA=' });
    const metric = (options.onEvent as jest.Mock).mock.calls
      .map(([event]) => event)
      .find((event) => event.type === 'voice-latency');
    expect(metric.speechEndToFirstAudioMs).toBeGreaterThanOrEqual(
      metric.endOfTurnToFirstAudioMs,
    );
    expect(metric.endpoint).toBe('server_audio_received');
  });

  it.each([
    ['live camelCase', 'contextId', 'isFinal'],
    ['reference snake_case', 'context_id', 'is_final'],
  ])(
    'forwards real speech audio and completes %s provider frames',
    async (_label, contextKey, finalKey) => {
      await connect();
      turn();
      await settle();
      const id = context();
      const audio = Buffer.alloc(960, 1).toString('base64');
      message(tts, {
        audio,
        [contextKey]: id,
        [finalKey]: null,
        normalizedAlignment: null,
        alignment: null,
      });
      expect(options.onEvent).toHaveBeenCalledWith({
        type: 'audio-delta',
        delta: audio,
        turnId: id,
      });
      expect(options.onEvent).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'audio-done' }),
      );
      message(tts, { audio: null, [contextKey]: id, [finalKey]: true });
      expect(options.onEvent).toHaveBeenCalledWith({
        type: 'audio-done',
        turnId: id,
      });
      expect(
        (options.onEvent as jest.Mock).mock.calls.filter(
          ([event]) => event.type === 'voice-latency',
        ),
      ).toHaveLength(1);
      // A repeated final frame must not complete a later turn or emit completion twice.
      message(tts, { [contextKey]: id, [finalKey]: true });
      expect(
        (options.onEvent as jest.Mock).mock.calls.filter(
          ([event]) => event.type === 'audio-done',
        ),
      ).toHaveLength(1);
    },
  );

  it('still rejects interrupted camelCase audio while forwarding the next context', async () => {
    await connect();
    turn();
    await settle();
    const oldId = context();
    message(stt, { type: 'TurnInfo', event: 'StartOfTurn', turn_index: 1 });
    turn('Actually, tell me about karting.', 1);
    await settle();
    const newId = tts.send.mock.calls
      .map(([data]) => JSON.parse(data))
      .filter((event) => event.text === ' ')
      .at(-1).context_id;
    message(tts, { contextId: oldId, audio: 'AAA=', isFinal: true });
    expect(options.onEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'audio-delta', turnId: oldId }),
    );
    message(tts, { contextId: newId, audio: 'AAA=', isFinal: null });
    expect(options.onEvent).toHaveBeenCalledWith({
      type: 'audio-delta',
      delta: 'AAA=',
      turnId: newId,
    });
  });
  it('reconnects STT with bounded backoff, retains queued input, and does not reconnect after close', async () => {
    await connect();
    stt.close();
    service.sendAudio('call', Buffer.alloc(960).toString('base64'));
    await jest.advanceTimersByTimeAsync(400);
    const replacement = sockets.instances[2];
    expect(replacement).toBeDefined();
    replacement.readyState = 1;
    message(replacement, { type: 'Connected' });
    await settle();
    expect(options.onEvent).toHaveBeenCalledWith({
      type: 'provider-reconnected',
      provider: 'stt',
    });
    await service.closeSession('call', false);
    await jest.advanceTimersByTimeAsync(10000);
    expect(sockets.instances).toHaveLength(3);
  });
  it('preserves final transcripts during close without generating another reply', async () => {
    await connect();
    const close = service.closeSession('call');
    turn('One last detail');
    await jest.advanceTimersByTimeAsync(750);
    await close;
    expect(options.onTranscript).toHaveBeenCalledWith(
      'user',
      'One last detail ',
    );
    expect(create).not.toHaveBeenCalled();
    expect(service.hasSession('call')).toBe(false);
  });

  it('preserves an unfinished caller turn on hangup when Flux only supplied a partial transcript', async () => {
    await connect();
    message(stt, {
      type: 'TurnInfo',
      event: 'Update',
      transcript: 'One unfinished detail',
    });
    const close = service.closeSession('call');
    await jest.advanceTimersByTimeAsync(750);
    await close;
    expect(options.onTranscript).toHaveBeenCalledWith(
      'user',
      'One unfinished detail ',
    );
    expect(create).not.toHaveBeenCalled();
  });
  it('rejects unbounded input and closes the pipeline without leaking reconnect timers', async () => {
    await connect();
    stt.close();
    for (let i = 0; i < 27; i++)
      service.sendAudio('call', Buffer.alloc(3840).toString('base64'));
    await settle();
    expect(options.onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'realtime-error',
        error: expect.objectContaining({ recoverable: false }),
      }),
    );
    await jest.advanceTimersByTimeAsync(10000);
    expect(sockets.instances).toHaveLength(2);
  });
});
