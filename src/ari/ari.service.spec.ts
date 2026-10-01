import { EventEmitter } from 'node:events';
import { ConfigService } from '@nestjs/config';
import axios, { type AxiosInstance } from 'axios';
import WebSocket from 'ws';
import { AriService } from './ari.service';
import { AriRtpMediaService } from './ari-rtp-media.service';
import { AriWebSocketGateway } from './ari-websocket.gateway';
import { VoiceService } from '../voice/voice.service';
import { CallLatency } from './call-latency';

jest.mock('ws', () => {
  const events =
    jest.requireActual<typeof import('node:events')>('node:events');
  class FakeSocket extends events.EventEmitter {
    static OPEN = 1;
    static CONNECTING = 0;
    static instances: FakeSocket[] = [];
    readyState = 0;
    send = jest.fn();
    close = jest.fn(() => {
      this.readyState = 3;
      this.emit('close');
    });
    terminate = jest.fn(() => {
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

type Socket = EventEmitter & {
  readyState: number;
  send: jest.Mock;
  close: jest.Mock;
  terminate: jest.Mock;
};
const sockets = WebSocket as unknown as { instances: Socket[] };
type Harness = {
  handleStasisStart(event: { channel: { id: string } }): Promise<void>;
  handleChannelCleanup(event: { channel: { id: string } }): Promise<void>;
  handleInboundRtpFrame(callId: string, payload: Buffer): void;
  sessions: Map<string, unknown>;
  aiSessions: Map<string, unknown>;
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function settle() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe('AriService phone startup', () => {
  let service: AriService;
  let api: Harness;
  let request: jest.Mock<
    Promise<{ data: object }>,
    [{ url: string; params?: { variable?: string; channel?: string } }]
  >;
  let rtp: {
    registerCallSession: jest.Mock;
    unregisterCallSession: jest.Mock;
    setRemoteEndpoint: jest.Mock;
    sendUlawToCall: jest.Mock;
    flushQueue: jest.Mock;
  };
  beforeEach(() => {
    sockets.instances = [];
    request = jest.fn(
      (options: { url: string; params?: { variable?: string } }) => {
        const variable = options.params?.variable;
        return Promise.resolve({
          data: variable
            ? { value: variable.endsWith('ADDRESS') ? '127.0.0.1' : '18000' }
            : { id: 'extmedia-phone' },
        });
      },
    );
    jest
      .spyOn(axios, 'create')
      .mockReturnValue({ request } as unknown as AxiosInstance);
    const values: Record<string, string> = {
      OPENAI_API_KEY: 'test-key',
      ASTERISK_ARI_APP: 'lemans-bot',
    };
    const config = {
      get: (name: string) => values[name],
    } as unknown as ConfigService;
    rtp = {
      registerCallSession: jest.fn(),
      unregisterCallSession: jest.fn(),
      setRemoteEndpoint: jest.fn(),
      sendUlawToCall: jest.fn(),
      flushQueue: jest.fn(),
    };
    service = new AriService(
      config,
      rtp as unknown as AriRtpMediaService,
      {} as AriWebSocketGateway,
      {} as VoiceService,
    );
    api = service as unknown as Harness;
    CallLatency.start('phone');
  });
  afterEach(async () => {
    await api.handleChannelCleanup({ channel: { id: 'phone' } });
    CallLatency.end('phone');
    jest.restoreAllMocks();
  });
  function ready() {
    const ws = sockets.instances[0];
    ws.readyState = 1;
    ws.emit('open');
    ws.emit(
      'message',
      Buffer.from(JSON.stringify({ type: 'session.started' })),
    );
    return ws;
  }
  function blockBridge() {
    const bridge = deferred<{ data: object }>();
    const normal = request.getMockImplementation()!;
    request.mockImplementation(
      (options: { url: string; params?: { variable?: string } }) =>
        options.url.endsWith('/ari/bridges') ? bridge.promise : normal(options),
    );
    return bridge;
  }

  it('starts GPT after answer while bridge creation is still pending', async () => {
    const bridge = blockBridge();
    const startup = api.handleStasisStart({ channel: { id: 'phone' } });
    await settle();
    try {
      expect(sockets.instances).toHaveLength(1);
    } finally {
      bridge.resolve({ data: {} });
      await startup;
    }
  });

  it('waits for media binding before greeting and preserves caller audio until session.started', async () => {
    const bridge = blockBridge();
    const startup = api.handleStasisStart({ channel: { id: 'phone' } });
    await settle();
    try {
      expect(sockets.instances).toHaveLength(1);
      api.handleInboundRtpFrame('phone', Buffer.from([1, 2, 3]));
      const ws = ready();
      expect(ws.send).toHaveBeenCalledTimes(1); // session.start only
      bridge.resolve({ data: {} });
      await startup;
      const events = ws.send.mock.calls.map(
        (args: [string]) =>
          JSON.parse(args[0]) as { type: string; audio?: string },
      );
      expect(events.map((event) => event.type)).toEqual([
        'session.start',
        'session.instructions.append',
        'session.input_audio.append',
      ]);
      expect(events[2].audio).toBe(Buffer.from([1, 2, 3]).toString('base64'));
      expect(rtp.setRemoteEndpoint).toHaveBeenCalledWith(
        'phone',
        '127.0.0.1',
        18000,
      );
      ws.emit('message', Buffer.from('{"type":"session.started"}'));
      expect(ws.send).toHaveBeenCalledTimes(3);
    } finally {
      bridge.resolve({ data: {} });
      await startup;
    }
  });

  it('buffers unexpected GPT audio until the RTP destination and bridge are ready', async () => {
    const bridge = blockBridge();
    const startup = api.handleStasisStart({ channel: { id: 'phone' } });
    await settle();
    try {
      const ws = ready();
      ws.emit(
        'message',
        Buffer.from('{"type":"session.output_audio.delta","delta":"AQID"}'),
      );
      expect(rtp.sendUlawToCall).not.toHaveBeenCalled();
      bridge.resolve({ data: {} });
      await startup;
      expect(rtp.sendUlawToCall).toHaveBeenCalledWith(
        'phone',
        Buffer.from([1, 2, 3]),
      );
    } finally {
      bridge.resolve({ data: {} });
      await startup;
    }
  });

  it('ignores duplicate caller and externalMedia StasisStart during startup', async () => {
    const bridge = blockBridge();
    const first = api.handleStasisStart({ channel: { id: 'phone' } });
    await settle();
    await api.handleStasisStart({ channel: { id: 'phone' } });
    await api.handleStasisStart({ channel: { id: 'extmedia-phone' } });
    bridge.resolve({ data: {} });
    await first;
    expect(
      request.mock.calls.filter((args: [{ url: string }]) =>
        args[0].url.endsWith('/answer'),
      ),
    ).toHaveLength(1);
    expect(sockets.instances).toHaveLength(1);
  });

  it('cleans up late-created resources after disconnect during bridge creation', async () => {
    const bridge = blockBridge();
    const startup = api.handleStasisStart({ channel: { id: 'phone' } });
    await settle();
    const cleanup = api.handleChannelCleanup({ channel: { id: 'phone' } });
    bridge.resolve({ data: {} });
    await Promise.all([startup, cleanup]);
    expect(api.sessions.size).toBe(0);
    expect(api.aiSessions.size).toBe(0);
    expect(
      request.mock.calls.some(
        (args: [{ url: string; method: string }]) =>
          args[0].method === 'delete' &&
          args[0].url.endsWith('/bridges/bridge-phone'),
      ),
    ).toBe(true);
    expect(
      request.mock.calls.some((args: [{ url: string }]) =>
        args[0].url.endsWith('/externalMedia'),
      ),
    ).toBe(false);
  });

  it('cleans up an external channel created after the caller has disconnected', async () => {
    const media = deferred<{ data: { id: string } }>();
    const normal = request.getMockImplementation()!;
    request.mockImplementation((options: { url: string }) =>
      options.url.endsWith('/externalMedia') ? media.promise : normal(options),
    );
    const startup = api.handleStasisStart({ channel: { id: 'phone' } });
    await settle();
    const cleanup = api.handleChannelCleanup({ channel: { id: 'phone' } });
    media.resolve({ data: { id: 'extmedia-phone' } });
    await Promise.all([startup, cleanup]);
    expect(api.sessions.size).toBe(0);
    expect(
      request.mock.calls.some(
        (args: [{ url: string; method: string }]) =>
          args[0].method === 'delete' &&
          args[0].url.endsWith('/channels/extmedia-phone'),
      ),
    ).toBe(true);
  });

  it('closes GPT and cleans resources when media setup fails', async () => {
    request.mockImplementation((options: { url: string }) =>
      options.url.endsWith('/ari/bridges')
        ? Promise.reject(new Error('bridge failed'))
        : Promise.resolve({ data: {} }),
    );
    await api.handleStasisStart({ channel: { id: 'phone' } });
    expect(sockets.instances[0].terminate).toHaveBeenCalled();
    expect(api.sessions.size).toBe(0);
    expect(api.aiSessions.size).toBe(0);
  });

  it('cancels bridge startup when the GPT connection fails', async () => {
    const bridge = blockBridge();
    const startup = api.handleStasisStart({ channel: { id: 'phone' } });
    await settle();
    try {
      sockets.instances[0].emit('error', new Error('connection failed'));
      bridge.resolve({ data: {} });
      await startup;
      await settle();
      expect(api.sessions.size).toBe(0);
      expect(api.aiSessions.size).toBe(0);
      expect(rtp.unregisterCallSession).toHaveBeenCalled();
    } finally {
      bridge.resolve({ data: {} });
      await startup;
    }
  });

  it('never starts GPT or creates a bridge after disconnect while answer is in flight', async () => {
    const answer = deferred<{ data: object }>();
    const normal = request.getMockImplementation()!;
    request.mockImplementation((options: { url: string }) =>
      options.url.endsWith('/answer') ? answer.promise : normal(options),
    );
    const startup = api.handleStasisStart({ channel: { id: 'phone' } });
    const cleanup = api.handleChannelCleanup({ channel: { id: 'phone' } });
    answer.resolve({ data: {} });
    await Promise.all([startup, cleanup]);
    expect(sockets.instances).toHaveLength(0);
    expect(api.sessions.size).toBe(0);
  });

  it('does not send caller audio on WebSocket open before session.started', async () => {
    await api.handleStasisStart({ channel: { id: 'phone' } });
    const ws = sockets.instances[0];
    ws.readyState = 1;
    ws.emit('open');
    api.handleInboundRtpFrame('phone', Buffer.from([1, 2, 3]));
    expect(ws.send).toHaveBeenCalledTimes(1);
    ws.emit('message', Buffer.from('{"type":"session.started"}'));
    expect(ws.send).toHaveBeenCalledTimes(3);
  });

  it('cleans up a GPT session that never becomes ready', async () => {
    jest.useFakeTimers();
    try {
      await api.handleStasisStart({ channel: { id: 'phone' } });
      jest.advanceTimersByTime(15_000);
      await api.handleChannelCleanup({ channel: { id: 'phone' } });
      expect(api.sessions.size).toBe(0);
      expect(api.aiSessions.size).toBe(0);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('fails cleanly rather than silently dropping caller speech if startup buffering is exhausted', async () => {
    await api.handleStasisStart({ channel: { id: 'phone' } });
    api.handleInboundRtpFrame('phone', Buffer.alloc(80_001));
    await api.handleChannelCleanup({ channel: { id: 'phone' } });
    expect(api.sessions.size).toBe(0);
    expect(api.aiSessions.size).toBe(0);
  });

  it('waits for an in-flight media join before cleaning up a failed endpoint lookup', async () => {
    const join = deferred<{ data: object }>();
    const normal = request.getMockImplementation()!;
    request.mockImplementation(
      (options: {
        url: string;
        params?: { channel?: string; variable?: string };
      }) => {
        if (
          options.url.endsWith('/addChannel') &&
          options.params?.channel === 'extmedia-phone'
        )
          return join.promise;
        if (options.params?.variable)
          return Promise.reject(new Error('variable unavailable'));
        return normal(options);
      },
    );
    const startup = api.handleStasisStart({ channel: { id: 'phone' } });
    await settle();
    expect(api.sessions.size).toBe(1);
    join.resolve({ data: {} });
    await startup;
    expect(api.sessions.size).toBe(0);
    expect(api.aiSessions.size).toBe(0);
  });

  it('rejects new calls during shutdown and cleans startup resources after the in-flight request settles', async () => {
    const bridge = blockBridge();
    const startup = api.handleStasisStart({ channel: { id: 'phone' } });
    await settle();
    const shutdown = service.onModuleDestroy();
    await api.handleStasisStart({ channel: { id: 'late-call' } });
    expect(sockets.instances).toHaveLength(1);
    bridge.resolve({ data: {} });
    await Promise.all([startup, shutdown]);
    expect(api.sessions.size).toBe(0);
    expect(api.aiSessions.size).toBe(0);
  });
});
