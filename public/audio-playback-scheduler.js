(function (root) {
  function createPlaybackScheduler(leadSeconds = 0.06) {
    let nextPlayTime = 0;

    return {
      playbackRate: 1,
      schedule(duration, currentTime) {
        const startAt = Math.max(nextPlayTime, currentTime + leadSeconds);
        nextPlayTime = startAt + duration;
        return startAt;
      },
      reset(currentTime) {
        nextPlayTime = currentTime;
      },
    };
  }

  root.createPlaybackScheduler = createPlaybackScheduler;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { createPlaybackScheduler };
  }
})(typeof window !== 'undefined' ? window : globalThis);
