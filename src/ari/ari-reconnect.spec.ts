import { EventEmitter } from 'node:events';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import WebSocket from 'ws';
import { AriService } from './ari.service';
import { AriRtpMediaService } from './ari-rtp-media.service';
import { AriWebSocketGateway } from './ari-websocket.gateway';
import { VoiceService } from '../voice/voice.service';

jest.mock('ws', () => {
  const { EventEmitter } = jest.requireActual('node:events');
  class FakeSocket extends EventEmitter {
    static OPEN = 1;
    static CONNECTING = 0;
    static instances: FakeSocket[] = [];
    readyState = 1;
    close = jest.fn(() => {
      this.readyState = 3;
      this.emit('close');
    });
    terminate = this.close;
    constructor() {
      super();
      FakeSocket.instances.push(this);
    }
  }
  return { __esModule: true, default: FakeSocket };
});

type FakeSocket = EventEmitter & { close: jest.Mock; readyState: number };
const sockets = WebSocket as unknown as { instances: FakeSocket[] };
type Harness = {
  sessions: Map<string, any>;
  aiSessions: Map<string, any>;
  pendingCleanups: Map<string, { kind: string; id: string }>;
  handleChannelCleanup(event: { channel: { id: string } }): Promise<void>;
};
async function settle() {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}
const missing = () => ({ isAxiosError: true, response: { status: 404 } });

describe('ARI reconnect reconciliation', () => {
  let service: AriService;
  let api: Harness;
  let request: jest.Mock;
  let finalize: jest.Mock;
  let unregister: jest.Mock;
  let events: FakeSocket;
  let absent: Set<string>;

  beforeEach(() => {
    jest.useFakeTimers();
    sockets.instances = [];
    absent = new Set();
    request = jest.fn(async ({ method, url }) => {
      const channelId = decodeURIComponent(url.split('/channels/')[1] ?? '');
      if (method === 'get' && absent.has(channelId)) throw missing();
      return { data: { id: channelId } };
    });
    jest
      .spyOn(axios, 'create')
      .mockReturnValue({ request } as unknown as AxiosInstance);
    finalize = jest.fn().mockResolvedValue(undefined);
    unregister = jest.fn();
    service = new AriService(
      new ConfigService({ ASTERISK_ARI_AUTO_CONNECT: 'true' }),
      {
        setStartupFailureHandler: jest.fn(),
        setAudioFrameHandler: jest.fn(),
        unregisterCallSession: unregister,
      } as unknown as AriRtpMediaService,
      { setAudioProcessor: jest.fn() } as unknown as AriWebSocketGateway,
      { finalizeExternalSession: finalize } as unknown as VoiceService,
    );
    api = service as unknown as Harness;
    service.onModuleInit();
    events = sockets.instances[0];
    events.emit('open');
  });
  afterEach(async () => {
    const shutdown = service.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(750);
    await shutdown;
    expect(jest.getTimerCount()).toBe(0);
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  function track(id: string, mediaReady = true) {
    const ws = new WebSocket('ws://test') as unknown as FakeSocket;
    const session = {
      callId: id,
      inboundChannelId: id,
      externalMediaChannelId: `extmedia-${id}`,
      bridgeId: `bridge-${id}`,
      ended: false,
      mediaReady,
      hangupInbound: false,
      turns: { close: jest.fn() },
    };
    api.sessions.set(id, session);
    api.aiSessions.set(id, {
      ws,
      ready: true,
      closed: false,
      pendingInput: [],
      pendingOutput: [],
      startupTimer: null,
    });
    return { session, ws };
  }
  async function reconnect() {
    events.readyState = 3;
    events.emit('close');
    await jest.advanceTimersByTimeAsync(3000);
    events = sockets.instances.at(-1)!;
    events.emit('open');
    await settle();
  }

  it('cleans a missed hangup after reconnect while preserving a live call', async () => {
    const ended = track('ended');
    const live = track('live');
    absent.add('ended');
    await reconnect();
    await jest.advanceTimersByTimeAsync(750);
    expect(api.sessions.has('ended')).toBe(false);
    expect(api.aiSessions.has('ended')).toBe(false);
    expect(ended.ws.close).toHaveBeenCalledTimes(1);
    expect(unregister).toHaveBeenCalledWith('ended');
    expect(finalize.mock.calls).toEqual([['ended']]);
    expect(api.sessions.get('live')).toBe(live.session);
    expect(live.ws.close).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'delete',
        url: expect.stringMatching('/channels/extmedia-ended$'),
      }),
    );
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'delete',
        url: expect.stringMatching('/bridges/bridge-ended$'),
      }),
    );
    expect(
      request.mock.calls.some(
        ([options]) =>
          options.method === 'delete' && options.url.endsWith('/channels/live'),
      ),
    ).toBe(false);
  });

  it.each(['network error', 'HTTP 503', 'invalid response'])(
    'preserves sessions on %s and retries without needing another reconnect',
    async (failure) => {
      track('phone');
      const normal = request.getMockImplementation()!;
      request.mockImplementationOnce(async () => {
        if (failure === 'invalid response') return { data: {} };
        throw failure === 'HTTP 503'
          ? { isAxiosError: true, response: { status: 503 } }
          : new Error('offline');
      });
      await reconnect();
      expect(api.sessions.has('phone')).toBe(true);
      expect(finalize).not.toHaveBeenCalled();
      expect(request).toHaveBeenCalledTimes(1);
      request.mockImplementation(normal);
      absent.add('phone');
      const socketCount = sockets.instances.length;
      await jest.advanceTimersByTimeAsync(3750);
      expect(api.sessions.has('phone')).toBe(false);
      expect(finalize).toHaveBeenCalledTimes(1);
      expect(sockets.instances).toHaveLength(socketCount);
    },
  );

  it('hangs up the caller if its established audio channel disappeared during the outage', async () => {
    track('phone');
    absent.add('extmedia-phone');
    await reconnect();
    await jest.advanceTimersByTimeAsync(750);
    expect(api.sessions.has('phone')).toBe(false);
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'delete',
        url: expect.stringMatching('/channels/phone$'),
      }),
    );
  });

  it('does not mistake an audio channel still being created for a failed channel', async () => {
    track('phone', false);
    absent.add('extmedia-phone');
    await reconnect();
    expect(api.sessions.has('phone')).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
    expect(finalize).not.toHaveBeenCalled();
  });

  it('ignores a late check from a connection that has disconnected again', async () => {
    track('phone');
    let reject!: (reason: unknown) => void;
    request.mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    await reconnect();
    events.emit('close');
    reject(missing());
    await settle();
    expect(api.sessions.has('phone')).toBe(true);
    expect(finalize).not.toHaveBeenCalled();
  });

  it('does not remove a replacement session when an older check finishes late', async () => {
    track('phone');
    let reject!: (reason: unknown) => void;
    request.mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    await reconnect();
    const replacement = track('phone');
    reject(missing());
    await settle();
    expect(api.sessions.get('phone')).toBe(replacement.session);
    expect(replacement.ws.close).not.toHaveBeenCalled();
    expect(finalize).not.toHaveBeenCalled();
  });

  it('shares cleanup with a hangup event received while verification is in flight', async () => {
    track('phone');
    let reject!: (reason: unknown) => void;
    request.mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    await reconnect();
    const cleanup = api.handleChannelCleanup({ channel: { id: 'phone' } });
    reject(missing());
    await settle();
    await jest.advanceTimersByTimeAsync(750);
    await cleanup;
    expect(finalize).toHaveBeenCalledTimes(1);
    expect(unregister).toHaveBeenCalledTimes(1);
    expect(api.sessions.size).toBe(0);
  });

  it('retries failed channel and bridge deletes after removing the call session', async () => {
    track('phone');
    const failedDeletes = new Set<string>();
    const normal = request.getMockImplementation()!;
    request.mockImplementation(async (options) => {
      if (options.method === 'delete' && !failedDeletes.has(options.url)) {
        failedDeletes.add(options.url);
        throw new Error('ARI temporarily unavailable');
      }
      return normal(options);
    });

    const cleanup = api.handleChannelCleanup({
      channel: { id: 'extmedia-phone' },
    });
    await jest.advanceTimersByTimeAsync(750);
    await cleanup;

    expect(api.sessions.has('phone')).toBe(false);
    expect(api.pendingCleanups.size).toBe(3);

    await jest.advanceTimersByTimeAsync(3000);
    await settle();

    expect(api.pendingCleanups.size).toBe(0);
    for (const suffix of [
      '/channels/phone',
      '/channels/extmedia-phone',
      '/bridges/bridge-phone',
    ]) {
      expect(
        request.mock.calls.filter(
          ([options]) =>
            options.method === 'delete' && options.url.endsWith(suffix),
        ),
      ).toHaveLength(2);
    }
  });

  it('treats already-missing channels and bridges as successfully cleaned', async () => {
    track('phone');
    request.mockImplementation(async (options) => {
      if (options.method === 'delete') throw missing();
      return { data: { id: 'phone' } };
    });

    const cleanup = api.handleChannelCleanup({
      channel: { id: 'extmedia-phone' },
    });
    await jest.advanceTimersByTimeAsync(750);
    await cleanup;

    expect(api.pendingCleanups.size).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
  });
});
