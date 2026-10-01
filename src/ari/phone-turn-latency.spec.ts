import { Logger } from '@nestjs/common';
import { CallLatency } from './call-latency';
import { PhoneTurnLatency } from './phone-turn-latency';

describe('PhoneTurnLatency diagnostics', () => {
  it('labels speech boundaries as local estimates and leaves unavailable provider metrics null', () => {
    jest.useFakeTimers();
    const log = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => {});
    CallLatency.start('turn-test');
    const turns = new PhoneTurnLatency('turn-test');
    try {
      for (let i = 0; i < 4; i++) {
        turns.input(Buffer.alloc(160, 0));
        jest.advanceTimersByTime(20);
      }
      for (let i = 0; i < 15; i++) {
        turns.input(Buffer.alloc(160, 255));
        jest.advanceTimersByTime(20);
      }
      turns.output();
      const output = log.mock.calls.map((args) => String(args[0])).join('\n');
      expect(output).toContain('USER_SPEECH_STARTED');
      expect(output).toContain('USER_SPEECH_STOPPED');
      expect(output).toContain('local_energy_estimate');
      expect(output).toContain('FIRST_RESPONSE_AUDIO');
      expect(output).toContain('"speech_end_to_response_ms":null');
      expect(output).toMatch(/"speech_end_to_first_audio_ms":\d/);
      expect(output).not.toContain('RESPONSE_DONE');
      jest.advanceTimersByTime(350);
      expect(
        log.mock.calls.some((args) =>
          String(args[0]).includes('RESPONSE_DONE'),
        ),
      ).toBe(true);
      turns.output();
      turns.close();
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      turns.close();
      CallLatency.end('turn-test');
      log.mockRestore();
      jest.useRealTimers();
    }
  });
});
