import { EventEmitter } from 'node:events';
import { ConfigService } from '@nestjs/config';
import { WebSocket, WebSocketServer } from 'ws';
import { AriWebSocketGateway } from './ari-websocket.gateway';

jest.mock('ws', () => ({
  ...jest.requireActual('ws'),
  WebSocketServer: jest.fn(),
}));

type Client = EventEmitter & {
  readyState: number;
  close: jest.Mock;
  terminate: jest.Mock;
  send: jest.Mock;
};

describe('ARI media WebSocket shutdown', () => {
  let gateway: AriWebSocketGateway;
  let server: EventEmitter & { clients: Set<Client>; close: jest.Mock };
  let finishServerClose: () => void;

  beforeEach(() => {
    jest.useFakeTimers();
    server = Object.assign(new EventEmitter(), {
      clients: new Set<Client>(),
      close: jest.fn((done: () => void) => {
        finishServerClose = done;
      }),
    });
    jest
      .mocked(WebSocketServer)
      .mockImplementation(() => server as unknown as WebSocketServer);
    gateway = new AriWebSocketGateway(
      new ConfigService({ WEBSOCKET_PORT: 9090 }),
    );
    gateway.onModuleInit();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  function connect(url: string): Client {
    const client = Object.assign(new EventEmitter(), {
      readyState: WebSocket.OPEN as number,
      close: jest.fn(() => {
        client.readyState = WebSocket.CLOSING;
      }),
      terminate: jest.fn(() => {
        client.readyState = WebSocket.CLOSED;
        client.emit('close', 1006, Buffer.alloc(0));
      }),
      send: jest.fn(),
    });
    server.clients.add(client);
    client.once('close', () => server.clients.delete(client));
    server.emit('connection', client, { url });
    return client;
  }

  it('closes every client gracefully and waits for server closure before finishing', async () => {
    const first = connect('/first');
    const second = connect('/second');
    const shutdown = gateway.onModuleDestroy();
    let finished = false;
    const completion = Promise.resolve(shutdown).then(() => {
      finished = true;
    });
    expect(server.close).toHaveBeenCalledTimes(1);
    expect(first.close).toHaveBeenCalledWith(1001, 'Server shutting down');
    expect(second.close).toHaveBeenCalledWith(1001, 'Server shutting down');
    expect(server.close.mock.invocationCallOrder[0]).toBeLessThan(
      first.close.mock.invocationCallOrder[0],
    );
    expect(gateway.getHealth().listening).toBe(false);
    await Promise.resolve();
    expect(finished).toBe(false);

    first.emit('close', 1001, Buffer.alloc(0));
    second.emit('close', 1001, Buffer.alloc(0));
    finishServerClose();
    await completion;
    expect(first.terminate).not.toHaveBeenCalled();
    expect(second.terminate).not.toHaveBeenCalled();
    expect(gateway.getHealth()).toMatchObject({
      listening: false,
      activeConnections: 0,
      activeCalls: 0,
    });
    expect(jest.getTimerCount()).toBe(0);
  });

  it('force-closes stuck and untracked clients after the grace period', async () => {
    const stuck = connect('/phone');
    const rejected = connect('/'); // Rejected sockets are absent from the call maps.
    const shutdown = gateway.onModuleDestroy();
    expect(gateway.onModuleDestroy()).toBe(shutdown);
    await jest.advanceTimersByTimeAsync(999);
    expect(stuck.terminate).not.toHaveBeenCalled();
    expect(rejected.terminate).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(stuck.terminate).toHaveBeenCalledTimes(1);
    expect(rejected.terminate).toHaveBeenCalledTimes(1);
    finishServerClose();
    await shutdown;
    expect(server.close).toHaveBeenCalledTimes(1);
    expect(gateway.onModuleDestroy()).toBe(shutdown);
    expect(gateway.getHealth()).toMatchObject({
      activeConnections: 0,
      activeCalls: 0,
    });
    expect(jest.getTimerCount()).toBe(0);
  });

  it('rejects late connections and ignores audio while shutting down', async () => {
    const existing = connect('/phone');
    const processor = jest.fn().mockResolvedValue(Buffer.from('reply'));
    gateway.setAudioProcessor(processor);
    const shutdown = gateway.onModuleDestroy();
    const late = connect('/late');
    expect(late.terminate).toHaveBeenCalledTimes(1);
    existing.emit('message', Buffer.from('audio'), true);
    expect(processor).not.toHaveBeenCalled();
    expect(gateway.sendAudioToCall('phone', Buffer.from('reply'))).toBe(false);
    existing.emit('close', 1001, Buffer.alloc(0));
    finishServerClose();
    await shutdown;
    expect(gateway.getHealth().activeCalls).toBe(0);
  });

  it('can shut down safely when initialization never created a server', async () => {
    const uninitialized = new AriWebSocketGateway(new ConfigService({}));
    const shutdown = uninitialized.onModuleDestroy();
    expect(uninitialized.onModuleDestroy()).toBe(shutdown);
    await shutdown;
    expect(uninitialized.getHealth().listening).toBe(false);
    expect(jest.getTimerCount()).toBe(0);
  });
});
