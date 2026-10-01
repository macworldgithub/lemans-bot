import { ConfigService } from '@nestjs/config';
import { type RemoteInfo, type Socket } from 'node:dgram';
import { AriRtpMediaService } from './ari-rtp-media.service';
import { CallLatency } from './call-latency';

type RtpHarness = {
  handleIncomingPacket(
    packet: Buffer,
    remote: RemoteInfo,
    receivedAtMs?: number,
  ): void;
  socket: Socket | null;
  sessions: Map<string, unknown>;
  remoteKeyToCallId: Map<string, string>;
  pendingPackets: Map<string, unknown>;
};
function packet(value: number) {
  const data = Buffer.alloc(172, value);
  data[0] = 0x80;
  data[1] = 0;
  return data;
}
function remote(port: number): RemoteInfo {
  return { address: '127.0.0.1', port, family: 'IPv4', size: 172 };
}

describe('AriRtpMediaService phone readiness', () => {
  let service: AriRtpMediaService;
  let api: RtpHarness;
  beforeEach(() => {
    service = new AriRtpMediaService({
      get: () => undefined,
    } as unknown as ConfigService);
    api = service as unknown as RtpHarness;
  });
  afterEach(() => {
    service.onModuleDestroy();
    jest.useRealTimers();
  });

  it('maps concurrent calls by their reported endpoints and replays early packets in order', () => {
    const frame = jest.fn();
    service.setAudioFrameHandler(frame);
    service.registerCallSession('first', true);
    service.registerCallSession('second', true);
    api.handleIncomingPacket(packet(2), remote(18002), 100);
    api.handleIncomingPacket(packet(3), remote(18002), 120);
    api.handleIncomingPacket(packet(1), remote(18001), 140);
    expect(frame).not.toHaveBeenCalled();
    service.setRemoteEndpoint('second', '127.0.0.1', 18002);
    service.setRemoteEndpoint('first', '127.0.0.1', 18001);
    expect(
      frame.mock.calls.map(
        (args: [{ callId: string; payload: Buffer; receivedAtMs: number }]) => [
          args[0].callId,
          args[0].payload[0],
          args[0].receivedAtMs,
        ],
      ),
    ).toEqual([
      ['second', 2, 100],
      ['second', 3, 120],
      ['first', 1, 140],
    ]);
    expect(api.pendingPackets.size).toBe(0);
    expect(() =>
      service.setRemoteEndpoint('first', '127.0.0.1', 18002),
    ).toThrow('another call');
  });

  it('sends the first RTP packet only on the 20 ms tick and releases timers on hangup', () => {
    jest.useFakeTimers();
    const send = jest.fn(
      (
        _data: Buffer,
        _port: number,
        _host: string,
        done: (error: Error | null) => void,
      ) => done(null),
    );
    api.socket = { send, close: jest.fn() } as unknown as Socket;
    service.registerCallSession('phone', true);
    service.setRemoteEndpoint('phone', '127.0.0.1', 18000);
    CallLatency.start('phone');
    service.sendUlawToCall('phone', Buffer.alloc(320));
    jest.advanceTimersByTime(19);
    expect(send).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(send).toHaveBeenCalledTimes(1);
    service.unregisterCallSession('phone');
    jest.advanceTimersByTime(100);
    expect(send).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
    expect(api.remoteKeyToCallId.size).toBe(0);
    CallLatency.end('phone');
  });

  it('clears unaffiliated startup packets when the waiting call disconnects', () => {
    service.registerCallSession('phone', true);
    api.handleIncomingPacket(packet(1), remote(18000));
    expect(api.pendingPackets.size).toBe(1);
    service.unregisterCallSession('phone');
    expect(api.pendingPackets.size).toBe(0);
    expect(api.sessions.size).toBe(0);
  });

  it('reports startup buffer overflow explicitly instead of silently truncating audio', () => {
    const fail = jest.fn();
    service.setStartupFailureHandler(fail);
    service.registerCallSession('phone', true);
    const oversized = Buffer.alloc(80_001);
    oversized[0] = 0x80;
    api.handleIncomingPacket(oversized, remote(18000));
    expect(fail).toHaveBeenCalledWith('phone', 'RTP_STARTUP_BUFFER_LIMIT');
    expect(api.pendingPackets.size).toBe(0);
  });
});
