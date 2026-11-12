import { createHash } from 'node:crypto';

import {
  hoursRowSchema,
  parseHoursSnapshot,
  type HoursQueryResult,
  type HoursRow,
  type HoursSnapshot,
  type HoursStatus,
  type ScheduleType,
} from './schema.js';

export interface HoursServiceOptions {
  timezone?: string;
  maxAgeMs?: number;
  clock?: () => Date;
  onSnapshotSaved?: (snapshot: HoursSnapshot) => Promise<void>;
}

export class HoursService {
  readonly timezone: string;
  readonly maxAgeMs: number;
  private clock: () => Date;
  private snapshot?: HoursSnapshot;
  private onSnapshotSaved?: (snapshot: HoursSnapshot) => Promise<void>;

  constructor(options: HoursServiceOptions = {}) {
    this.timezone = options.timezone ?? 'Australia/Melbourne';
    this.maxAgeMs = options.maxAgeMs ?? 900_000; // 15 minutes
    this.clock = options.clock ?? (() => new Date());
    this.onSnapshotSaved = options.onSnapshotSaved;

    // Validate timezone at startup
    try {
      new Intl.DateTimeFormat('en-AU', { timeZone: this.timezone });
    } catch {
      throw new Error(`Invalid timezone configured: ${this.timezone}`);
    }
  }

  setClock(clock: () => Date): void {
    this.clock = clock;
  }

  getSnapshot(): HoursSnapshot | undefined {
    return this.snapshot;
  }

  loadSnapshot(snapshot: unknown): boolean {
    const validated = parseHoursSnapshot(snapshot, this.clock().getTime());
    if (!validated) return false;
    this.snapshot = validated;
    return true;
  }

  getLocalDate(date: Date = this.clock()): string {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: this.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);
    return parts; // YYYY-MM-DD
  }

  getLocalTime(date: Date = this.clock()): string {
    // 24-hour HH:mm
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: this.timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(date);
    return parts;
  }

  getYesterdayLocalDate(date: Date = this.clock()): string {
    const prev = new Date(date.getTime() - 24 * 60 * 60 * 1000);
    return this.getLocalDate(prev);
  }

  validateAndApplyRows(
    rawRows: unknown[],
    source = 'google_sheets',
  ): { success: boolean; error?: string } {
    const now = this.clock().getTime();
    if (!Array.isArray(rawRows) || rawRows.length === 0 || rawRows.length > 5000) {
      if (this.snapshot) this.snapshot.lastAttemptAt = now;
      return { success: false, error: 'Empty or invalid rows data' };
    }

    const validatedRows: HoursRow[] = [];
    const seen = new Set<string>();

    for (const raw of rawRows) {
      const parsed = hoursRowSchema.safeParse(raw);
      if (!parsed.success) {
        if (this.snapshot) this.snapshot.lastAttemptAt = now;
        return {
          success: false,
          error: `Row validation failed: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
        };
      }
      const row = parsed.data;
      const key = `${row.date}:${row.schedule}`;
      if (seen.has(key)) {
        if (this.snapshot) this.snapshot.lastAttemptAt = now;
        return { success: false, error: `Duplicate date/schedule entry found: ${key}` };
      }
      seen.add(key);
      validatedRows.push(row);
    }

    validatedRows.sort((a, b) => a.date.localeCompare(b.date));
    const coverageStart = validatedRows[0].date;
    const coverageEnd = validatedRows[validatedRows.length - 1].date;

    const hash = createHash('sha256')
      .update(JSON.stringify(validatedRows))
      .digest('hex')
      .slice(0, 16);

    const snapshot: HoursSnapshot = {
      version: hash,
      rows: validatedRows,
      source,
      lastSuccessAt: now,
      lastAttemptAt: now,
      coverageStart,
      coverageEnd,
    };

    const validated = parseHoursSnapshot(snapshot, now);
    if (!validated) return { success: false, error: 'Invalid snapshot data' };
    this.snapshot = validated;
    if (this.onSnapshotSaved) {
      void this.onSnapshotSaved(validated).catch(() => undefined);
    }

    return { success: true };
  }

  query(options: { date?: string; schedule: ScheduleType }): HoursQueryResult {
    const now = this.clock();
    const currentDate = this.getLocalDate(now);
    const targetDate = options.date ?? currentDate;
    const { schedule } = options;

    if (!this.snapshot) {
      return {
        status: 'unknown',
        date: targetDate,
        schedule,
        timezone: this.timezone,
      };
    }

    const age = now.getTime() - this.snapshot.lastSuccessAt;
    const status: HoursStatus = age > this.maxAgeMs ? 'stale' : 'current';

    const row = this.snapshot.rows.find((r) => r.date === targetDate && r.schedule === schedule);
    if (!row) {
      return {
        status: 'unknown',
        date: targetDate,
        schedule,
        timezone: this.timezone,
        snapshotVersion: this.snapshot.version,
        lastSuccessAt: this.snapshot.lastSuccessAt,
      };
    }

    let isOpenNow: boolean | undefined = undefined;

    // Evaluate isOpenNow only when querying the current local date
    if (targetDate === currentDate) {
      if (row.closed) {
        // An explicit closed current date overrides prior overnight window
        isOpenNow = false;
      } else if (row.opens && row.closes) {
        const currentTime = this.getLocalTime(now);
        if (!row.closesNextDay) {
          // Normal day: inclusive open, exclusive close
          isOpenNow = currentTime >= row.opens && currentTime < row.closes;
        } else {
          // Closes next day: open from opens until midnight
          isOpenNow = currentTime >= row.opens;
        }
      }

      // If not currently open during today's standard window, check if yesterday had overnight window extending into today
      if (!isOpenNow && !row.closed) {
        const yesterdayDate = this.getYesterdayLocalDate(now);
        const yRow = this.snapshot.rows.find((r) => r.date === yesterdayDate && r.schedule === schedule);
        if (yRow && !yRow.closed && yRow.closesNextDay && yRow.closes) {
          const currentTime = this.getLocalTime(now);
          if (currentTime < yRow.closes) {
            isOpenNow = true;
          }
        }
      }
    }

    return {
      status,
      date: targetDate,
      schedule,
      timezone: this.timezone,
      closed: row.closed,
      opens: row.opens,
      closes: row.closes,
      closesNextDay: row.closesNextDay,
      isOpenNow,
      snapshotVersion: this.snapshot.version,
      lastSuccessAt: this.snapshot.lastSuccessAt,
    };
  }
}
