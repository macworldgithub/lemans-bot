// Live transcript model shared by the demo page and the call monitor.
// Lines are keyed by id + role, so a caller line opened at speech start stays
// in place while its words stream in after the bot starts replying.
// Mirrors backend/src/shared/events.ts and backend/src/api/store.ts.

export type Role = 'bot' | 'user';

export interface TranscriptEvent {
  callId?: string;
  id: string;
  role: Role;
  /** interim replaces the line text, final replaces it and closes the line. */
  kind: 'interim' | 'final' | 'interrupted';
  text?: string;
  ts?: number;
}

export interface TranscriptLine {
  id: string;
  role: Role;
  text: string;
  final: boolean;
  interrupted: boolean;
  ts: number;
}

export interface SpeakerNames {
  bot: string;
  user: string;
}

export const DEFAULT_NAMES: SpeakerNames = { bot: 'Chloe', user: 'Caller' };

/** Returns a new line list with the event applied (same reducer as the server). */
export function applyTranscriptEvent(lines: TranscriptLine[], e: TranscriptEvent): TranscriptLine[] {
  const idx = lines.findIndex((l) => l.id === e.id && l.role === e.role);
  const prev: TranscriptLine =
    idx >= 0 ? lines[idx] : { id: e.id, role: e.role, text: '', final: false, interrupted: false, ts: e.ts ?? Date.now() };

  const next = { ...prev };
  if (e.kind === 'interim') next.text = e.text ?? next.text;
  else if (e.kind === 'final') {
    next.text = e.text ?? next.text;
    next.final = true;
  } else if (e.kind === 'interrupted') next.interrupted = true;

  if (idx < 0) {
    // Keep conversation order: a reply can be reported after the caller's next words.
    const at = lines.findIndex((l) => l.ts > next.ts);
    return at < 0 ? [...lines, next] : [...lines.slice(0, at), next, ...lines.slice(at)];
  }
  const copy = lines.slice();
  copy[idx] = next;
  return copy;
}

/** Marks lines that never got a final event (call ended mid-turn). */
export function finalizeAll(lines: TranscriptLine[]): TranscriptLine[] {
  return lines.some((l) => !l.final) ? lines.map((l) => (l.final ? l : { ...l, final: true })) : lines;
}

/** Elapsed time since call start as m:ss. */
export function formatStamp(ts: number, startedAt: number | null): string {
  const s = Math.max(0, Math.round((ts - (startedAt ?? ts)) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function toPlainText(lines: TranscriptLine[], startedAt: number | null, names: SpeakerNames): string {
  const start = startedAt ?? lines[0]?.ts ?? null;
  return lines
    .map((l) => {
      const text = l.text.trim() || '(no speech recognised)';
      return `[${formatStamp(l.ts, start)}] ${names[l.role]}: ${text}${l.interrupted ? ' [interrupted]' : ''}`;
    })
    .join('\n');
}

export function downloadText(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Filesystem-safe timestamp, e.g. 2026-10-26-14-03-22. */
export function fileStamp(date: Date): string {
  return date.toISOString().slice(0, 19).replace(/[:T]/g, '-');
}
