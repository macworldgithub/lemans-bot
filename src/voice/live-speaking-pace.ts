// GPT Live controls speaking pace through instructions, not a numeric audio speed.
export function getLiveSpeakingPace(value?: string) {
  const requested = value?.trim().toLowerCase();
  const name =
    requested &&
    ['slow', 'normal', 'brisk', 'fast', 'very_fast'].includes(requested)
      ? requested
      : 'brisk';

  return {
    name,
    instructions:
      `Speaking pace: ${name.replace('_', ' ')}. Speak smoothly with connected phrasing and brief natural pauses. ` +
      'Keep every word clear; slow a little bit down for phone numbers, email addresses, dates, and spelling. ' +
      'Pause after questions and yield when the caller interrupts.',
  };
}
