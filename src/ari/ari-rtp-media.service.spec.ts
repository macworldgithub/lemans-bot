import { ConfigService } from '@nestjs/config';
import { type RemoteInfo, type Socket } from 'node:dgram';
import { AriRtpMediaService } from './ari-rtp-media.service';
import { CallLatency } from './call-latency';
import { performance } from 'node:perf_hooks';

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
    jest.restoreAllMocks();
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
    let now = 0;
    jest.spyOn(performance, 'now').mockImplementation(() => now);
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
    now = 19;
    jest.advanceTimersByTime(19);
    expect(send).not.toHaveBeenCalled();
    now = 20;
    jest.advanceTimersByTime(1);
    expect(send).toHaveBeenCalledTimes(1);
    service.unregisterCallSession('phone');
    jest.advanceTimersByTime(100);
    expect(send).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
    expect(api.remoteKeyToCallId.size).toBe(0);
    CallLatency.end('phone');
  });

  it('preserves ten seconds of streamed speech without shortening it or inserting silence', () => {
    jest.useFakeTimers();
    let now = 0;
    jest.spyOn(performance, 'now').mockImplementation(() => now);
    const packets: { data: Buffer; at: number }[] = [];
    const send = jest.fn(
      (
        data: Buffer,
        _port: number,
        _host: string,
        done: (error: Error | null) => void,
      ) => {
        packets.push({ data: Buffer.from(data), at: now });
        done(null);
      },
    );
    api.socket = { send, close: jest.fn() } as unknown as Socket;
    service.registerCallSession('phone', true);
    service.setRemoteEndpoint('phone', '127.0.0.1', 18000);
    // 100ms provider chunks arrive at their actual playback rate. None of these
    // samples is mu-law silence, so artificial gaps cannot match the input.
    const original = Buffer.from(
      Array.from({ length: 80_000 }, (_, index) => index % 254),
    );
    let offset = 0;
    for (let tick = 0; tick < 500; tick++) {
      if (tick % 5 === 0) {
        service.sendUlawToCall(
          'phone',
          original.subarray(offset, offset + 800),
        );
        offset += 800;
      }
      now += 20;
      jest.advanceTimersByTime(20);
    }
    expect(packets).toHaveLength(500);
    const played = Buffer.concat(packets.map(({ data }) => data.subarray(12)));
    expect(played.length).toBe(original.length);
    expect(played.equals(original)).toBe(true);
    expect(service.isOutputQueueDrained('phone')).toBe(true);
    for (let index = 0; index < packets.length; index++) {
      expect(packets[index].at).toBe((index + 1) * 20);
      expect(packets[index].data.length).toBe(172);
      if (index > 0) {
        expect(packets[index].data.readUInt16BE(2)).toBe(
          (packets[index - 1].data.readUInt16BE(2) + 1) & 0xffff,
        );
        expect(packets[index].data.readUInt32BE(4)).toBe(
          (packets[index - 1].data.readUInt32BE(4) + 160) >>> 0,
        );
      }
    }
    service.unregisterCallSession('phone');
    expect(jest.getTimerCount()).toBe(0);
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
