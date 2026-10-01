import { Logger } from '@nestjs/common';
import { CallLatency } from './call-latency';

describe('CallLatency', () => {
  it('logs each milestone once per call and releases completed call state', () => {
    const log = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => {});
    try {
      CallLatency.start('call-a');
      CallLatency.start('call-b');
      CallLatency.mark('call-a', 'T12', 'First caller audio');
      CallLatency.mark('call-a', 'T12', 'Repeated audio');
      CallLatency.mark('call-b', 'T12', 'First caller audio');
      expect(log.mock.calls).toHaveLength(4);
      expect(log.mock.calls[2][0]).toMatch(
        /\[CALL-LATENCY\] .*call="call-a" \+\d+\.\d{3}ms T12/,
      );
      CallLatency.end('call-a');
      CallLatency.mark('call-a', 'T15', 'Late audio');
      expect(log.mock.calls).toHaveLength(5);
      CallLatency.end('call-b');
    } finally {
      log.mockRestore();
    }
  });
});
