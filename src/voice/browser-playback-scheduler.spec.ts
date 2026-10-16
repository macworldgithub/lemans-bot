import { createPlaybackScheduler } from '../../public/audio-playback-scheduler.js';

describe('browser playback scheduler', () => {
  it('plays incoming phone-length chunks at normal speed without creating gaps', () => {
    const scheduler = createPlaybackScheduler(0.06);
    const chunkDuration = 0.1;
    let previousEnd = 0;

    expect(scheduler.playbackRate).toBe(1);

    for (let chunk = 0; chunk < 20; chunk += 1) {
      const arrivalTime = chunk * chunkDuration;
      const startAt = scheduler.schedule(chunkDuration, arrivalTime);

      if (chunk > 0) {
        expect(startAt).toBeCloseTo(previousEnd, 10);
      }
      previousEnd = startAt + chunkDuration;
    }
  });

  it('starts a new playback timeline at the current audio clock after reset', () => {
    const scheduler = createPlaybackScheduler(0.06);
    scheduler.schedule(0.1, 0);

    scheduler.reset(4.25);

    expect(scheduler.schedule(0.1, 4.25)).toBeCloseTo(4.31, 10);
  });
});
