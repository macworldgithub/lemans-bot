import { SpeakerLock, SpeakerVerdict, StreamResampler } from './speaker-lock';
import { SpeakerVerifier } from './speaker-verifier.service';

// Fake model: a "voice" is a constant DC level; embedding says which sign it has.
const fakeVerifier: SpeakerVerifier = {
  ready: true,
  embed: (x) => {
    const mean = x.reduce((a, v) => a + v, 0) / (x.length || 1);
    return Promise.resolve(
      Float32Array.from(mean >= 0 ? [1, 0.05] : [0.05, 1]),
    );
  },
};

const CALLER = 0.5;
const OTHER = -0.5;
const flush = () => new Promise((r) => setImmediate(r));

function setup(responseActive = { value: false }) {
  const sent: any[] = [];
  const verdicts: Array<[string, SpeakerVerdict]> = [];
  const bargeIns: string[] = [];
  const lock = new SpeakerLock(fakeVerifier, {
    send: (e) => sent.push(e),
    isResponseActive: () => responseActive.value,
    onBargeIn: (id) => bargeIns.push(id),
    onVerdict: (id, v) => verdicts.push([id, v]),
  });
  let ms = 0;
  // Simulates one VAD turn of `sec` seconds of a voice at 16 kHz.
  const turn = async (id: string, level: number, sec: number) => {
    const start = ms;
    lock.handleEvent({
      type: 'input_audio_buffer.speech_started',
      item_id: id,
      audio_start_ms: start,
    });
    for (let i = 0; i < sec * 10; i++) {
      lock.pushFloat(new Float32Array(1600).fill(level), 16000);
      ms += 100;
      await flush();
    }
    lock.handleEvent({
      type: 'input_audio_buffer.speech_stopped',
      item_id: id,
      audio_end_ms: ms,
    });
    lock.handleEvent({ type: 'input_audio_buffer.committed', item_id: id });
    await flush();
    await flush();
    lock.pushFloat(new Float32Array(3200), 16000); // 200 ms silence
    ms += 200;
  };
  return { lock, sent, verdicts, bargeIns, turn, responseActive };
}

describe('SpeakerLock', () => {
  afterEach(() => jest.useRealTimers());

  it('learns the first caller, answers them, and ignores a different voice', async () => {
    const t = setup();
    await t.turn('u1', CALLER, 2);
    expect(t.verdicts[0][1]).toMatchObject({
      decision: 'accepted',
      reason: 'enrolling',
    });
    expect(t.lock.locked).toBe(true);
    expect(t.sent).toEqual([{ type: 'response.create' }]);

    await t.turn('u2', OTHER, 2);
    expect(t.verdicts[1][1]).toMatchObject({
      decision: 'rejected',
      reason: 'other-speaker',
    });
    expect(t.sent).toHaveLength(1); // no reply to the other voice

    // Ignored turn is removed from the conversation once transcribed.
    t.lock.handleEvent({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'u2',
    });
    expect(t.sent[1]).toEqual({
      type: 'conversation.item.delete',
      item_id: 'u2',
    });

    await t.turn('u3', CALLER, 2);
    expect(t.verdicts[2][1]).toMatchObject({
      decision: 'accepted',
      reason: 'match',
    });
    expect(t.sent[2]).toEqual({ type: 'response.create' });
    t.lock.close();
  });

  it('deletes still-pending ignored turns before answering the caller', async () => {
    const t = setup();
    await t.turn('u1', CALLER, 2);
    await t.turn('u2', OTHER, 2);
    await t.turn('u3', CALLER, 2);
    expect(t.sent.slice(1)).toEqual([
      { type: 'conversation.item.delete', item_id: 'u2' },
      { type: 'response.create' },
    ]);
    t.lock.close();
  });

  it('only cuts off the bot for the verified caller', async () => {
    const t = setup();
    await t.turn('u1', CALLER, 2);
    t.responseActive.value = true;
    t.sent.length = 0;
    t.bargeIns.length = 0;

    await t.turn('u2', OTHER, 2);
    expect(t.bargeIns).toEqual([]);
    expect(t.sent).not.toContainEqual({ type: 'response.cancel' });

    await t.turn('u3', CALLER, 2);
    expect(t.bargeIns).toEqual(['u3']);
    expect(t.sent).toContainEqual({ type: 'response.cancel' });
    // reply waits until the cancelled response is done
    expect(t.sent).not.toContainEqual({ type: 'response.create' });
    t.responseActive.value = false;
    t.lock.handleEvent({ type: 'response.done' });
    expect(t.sent[t.sent.length - 1]).toEqual({ type: 'response.create' });
    t.lock.close();
  });

  it('lets very short turns through unchecked', async () => {
    const t = setup();
    await t.turn('u1', CALLER, 2);
    await t.turn('u2', OTHER, 0.3);
    expect(t.verdicts[1][1]).toMatchObject({
      decision: 'accepted',
      reason: 'too-short',
    });
    t.lock.close();
  });

  it('fails open when the verifier is unavailable', async () => {
    const sent: any[] = [];
    const verdicts: SpeakerVerdict[] = [];
    const lock = new SpeakerLock(
      { ready: false, embed: () => Promise.reject(new Error('down')) },
      {
        send: (e) => sent.push(e),
        isResponseActive: () => false,
        onBargeIn: () => undefined,
        onVerdict: (_, v) => verdicts.push(v),
      },
    );
    lock.handleEvent({
      type: 'input_audio_buffer.speech_started',
      item_id: 'u1',
      audio_start_ms: 0,
    });
    lock.pushFloat(new Float32Array(16000), 16000);
    lock.handleEvent({
      type: 'input_audio_buffer.speech_stopped',
      item_id: 'u1',
      audio_end_ms: 1000,
    });
    lock.handleEvent({ type: 'input_audio_buffer.committed', item_id: 'u1' });
    await flush();
    expect(verdicts[0]).toMatchObject({
      decision: 'accepted',
      reason: 'unavailable',
    });
    expect(sent).toEqual([{ type: 'response.create' }]);
  });
});

describe('StreamResampler', () => {
  it.each([
    [24000, 128],
    [8000, 160],
  ])('keeps the %i Hz clock aligned across %i-sample chunks', (rate, chunk) => {
    const rs = new StreamResampler(rate);
    let out = 0;
    const seconds = 10;
    for (let i = 0; i < (rate * seconds) / chunk; i++) {
      out += rs.process(new Float32Array(chunk).fill(0.1)).length;
    }
    expect(Math.abs(out - 16000 * seconds)).toBeLessThanOrEqual(2);
  });
});
