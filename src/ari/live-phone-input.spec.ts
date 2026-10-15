import { LivePhoneInput } from './live-phone-input';

describe('GPT Live telephone input clock', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('keeps silent calls active and paces buffered caller audio without reordering it', () => {
    const send = jest.fn();
    const stream = new LivePhoneInput(send, jest.fn(), jest.fn());
    stream.start();
    jest.advanceTimersByTime(40);
    expect(send.mock.calls.map(([audio]) => audio)).toEqual([
      Buffer.alloc(160, 255),
      Buffer.alloc(160, 255),
    ]);
    send.mockClear();
    const speech = Buffer.from(Array.from({ length: 480 }, (_, i) => i % 256));
    stream.enqueue(speech);
    expect(send).not.toHaveBeenCalled();
    jest.advanceTimersByTime(20);
    expect(send).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(40);
    expect(Buffer.concat(send.mock.calls.map(([audio]) => audio))).toEqual(
      speech,
    );
    stream.close();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('reports sustained caller speech once and ignores short noise', () => {
    const speech = jest.fn();
    const stream = new LivePhoneInput(jest.fn(), speech, jest.fn());
    stream.start();
    stream.enqueue(Buffer.alloc(160, 0));
    jest.advanceTimersByTime(60);
    expect(speech).not.toHaveBeenCalled();
    stream.enqueue(Buffer.alloc(1280, 0));
    jest.advanceTimersByTime(160);
    expect(speech).toHaveBeenCalledTimes(1);
    stream.close();
  });

  it('delivers final caller words before completing hangup drain, then stops silence', async () => {
    const send = jest.fn();
    const stream = new LivePhoneInput(send, jest.fn(), jest.fn());
    const finalWords = Buffer.alloc(400, 55);
    stream.enqueue(finalWords);
    stream.start();
    const drain = stream.drain();
    expect(stream.drain()).toBe(drain);
    await jest.advanceTimersByTimeAsync(60);
    await drain;
    expect(
      Buffer.concat(send.mock.calls.map(([audio]) => audio)).subarray(0, 400),
    ).toEqual(finalWords);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('bounds input memory and resolves a pending drain when disconnected', async () => {
    const failure = jest.fn();
    const stream = new LivePhoneInput(jest.fn(), jest.fn(), failure);
    stream.enqueue(Buffer.alloc(80_000));
    stream.enqueue(Buffer.alloc(1));
    expect(failure).toHaveBeenCalledTimes(1);
    const drain = stream.drain();
    stream.close();
    await drain;
    expect(jest.getTimerCount()).toBe(0);
  });
});
