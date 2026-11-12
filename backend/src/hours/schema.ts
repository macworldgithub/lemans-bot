import { z } from 'zod';

export type ScheduleType = 'venue' | 'bookings' | 'large_events';
export type HoursStatus = 'current' | 'stale' | 'unknown';

const TIME_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_REGEX = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export function isValidIsoDate(dateStr: string): boolean {
  if (!DATE_REGEX.test(dateStr)) return false;
  const [year, month, day] = dateStr.split('-').map(Number);
  const d = new Date(Date.UTC(year, month - 1, day));
  return (
    d.getUTCFullYear() === year &&
    d.getUTCMonth() === month - 1 &&
    d.getUTCDate() === day
  );
}

export const hoursRowSchema = z
  .object({
    date: z.string().refine(isValidIsoDate, { message: 'Must be a valid ISO calendar date YYYY-MM-DD' }),
    schedule: z.enum(['venue', 'bookings', 'large_events']),
    closed: z.boolean(),
    opens: z.string().regex(TIME_REGEX, 'Must be HH:mm 24-hour time').optional(),
    closes: z.string().regex(TIME_REGEX, 'Must be HH:mm 24-hour time').optional(),
    closesNextDay: z.boolean().default(false),
  })
  .refine(
    (row) => {
      if (row.closed) {
        return !row.opens && !row.closes;
      }
      return Boolean(row.opens && row.closes);
    },
    { message: 'Closed rows must have no open/close times; open rows must specify both' },
  );

export type HoursRow = z.infer<typeof hoursRowSchema>;

const isoDate = z.string().refine(isValidIsoDate);
export const hoursSnapshotSchema = z.object({
  version: z.string().min(1).max(128),
  rows: z.array(hoursRowSchema).min(1).max(5000),
  source: z.string().min(1).max(128),
  lastSuccessAt: z.number().int().nonnegative(),
  lastAttemptAt: z.number().int().nonnegative(),
  coverageStart: isoDate,
  coverageEnd: isoDate,
}).superRefine((snapshot, ctx) => {
  const keys = new Set<string>();
  if (snapshot.lastAttemptAt < snapshot.lastSuccessAt || snapshot.coverageStart > snapshot.coverageEnd) {
    ctx.addIssue({ code: 'custom', message: 'Invalid snapshot bounds' });
  }
  for (const row of snapshot.rows) {
    const key = `${row.date}:${row.schedule}`;
    if (keys.has(key) || row.date < snapshot.coverageStart || row.date > snapshot.coverageEnd) {
      ctx.addIssue({ code: 'custom', message: 'Duplicate or out-of-range row' });
    }
    keys.add(key);
  }
});

export function parseHoursSnapshot(value: unknown, now = Date.now()) {
  const parsed = hoursSnapshotSchema.safeParse(value);
  return parsed.success && parsed.data.lastSuccessAt <= now ? parsed.data : undefined;
}

export const hoursQueryResultSchema = z.object({
  status: z.enum(['current', 'stale', 'unknown']),
  date: isoDate,
  schedule: z.enum(['venue', 'bookings', 'large_events']),
  timezone: z.string().min(1).max(128),
  closed: z.boolean().optional(),
  opens: z.string().regex(TIME_REGEX).optional(),
  closes: z.string().regex(TIME_REGEX).optional(),
  closesNextDay: z.boolean().optional(),
  isOpenNow: z.boolean().optional(),
  snapshotVersion: z.string().max(128).optional(),
  lastSuccessAt: z.number().int().nonnegative().optional(),
}).refine((row) => row.status !== 'current' || (row.closed !== undefined && (row.closed || Boolean(row.opens && row.closes))));

export type HoursSnapshot = z.infer<typeof hoursSnapshotSchema>;
export type HoursQueryResult = z.infer<typeof hoursQueryResultSchema>;
