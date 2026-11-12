import { describe, expect, it, vi } from 'vitest';

import { GoogleSheetsFetcher, HoursPoller } from '../src/hours/google.js';
import { HoursService } from '../src/hours/service.js';

describe('HoursService', () => {
  it('rejects invalid saved snapshots without replacing valid data or renewing its timestamp', () => {
    const now = new Date('2026-11-12T00:00:00Z');
    const service = new HoursService({ clock: () => now });
    const valid = { version: 'v1', source: 'test', lastSuccessAt: now.getTime() - 1000, lastAttemptAt: now.getTime(), coverageStart: '2026-11-12', coverageEnd: '2026-11-12', rows: [{ date: '2026-11-12', schedule: 'venue', closed: false, opens: '09:00', closes: '18:00', closesNextDay: false }] };
    expect(service.loadSnapshot(valid)).toBe(true);
    for (const invalid of [
      { ...valid, rows: undefined },
      { ...valid, rows: [valid.rows[0], valid.rows[0]] },
      { ...valid, rows: [{ ...valid.rows[0], date: '2026-02-30' }] },
      { ...valid, lastSuccessAt: now.getTime() + 1 },
      { ...valid, lastAttemptAt: valid.lastSuccessAt - 1 },
      { ...valid, coverageEnd: '2026-11-11' },
    ]) {
      expect(service.loadSnapshot(invalid)).toBe(false);
      expect(service.getSnapshot()?.lastSuccessAt).toBe(valid.lastSuccessAt);
    }
  });
  const sampleRows = [
    {
      date: '2026-11-12',
      schedule: 'venue' as const,
      closed: false,
      opens: '09:45',
      closes: '22:00',
      closesNextDay: false,
    },
    {
      date: '2026-11-13',
      schedule: 'venue' as const,
      closed: false,
      opens: '10:15',
      closes: '02:00',
      closesNextDay: true,
    },
    {
      date: '2026-11-14',
      schedule: 'venue' as const,
      closed: false,
      opens: '09:15',
      closes: '23:00',
      closesNextDay: false,
    },
    {
      date: '2026-12-25',
      schedule: 'venue' as const,
      closed: true,
      closesNextDay: false,
    },
    {
      date: '2026-12-31',
      schedule: 'venue' as const,
      closed: false,
      opens: '10:00',
      closes: '01:00',
      closesNextDay: true,
    },
    {
      date: '2027-01-01',
      schedule: 'venue' as const,
      closed: false,
      opens: '12:00',
      closes: '20:00',
      closesNextDay: false,
    },
  ];

  it('validates open and closed boundaries with inclusive opens and exclusive closes', () => {
    const service = new HoursService({ maxAgeMs: 60_000 });
    service.validateAndApplyRows(sampleRows);

    // 09:44 Melbourne time on 2026-11-12 (before open)
    service.setClock(() => new Date('2026-11-11T22:44:00Z')); // 22:44 UTC = 09:44 AEDT
    let res = service.query({ date: '2026-11-12', schedule: 'venue' });
    expect(res.isOpenNow).toBe(false);

    // 09:45 Melbourne time (inclusive open)
    service.setClock(() => new Date('2026-11-11T22:45:00Z')); // 09:45 AEDT
    res = service.query({ date: '2026-11-12', schedule: 'venue' });
    expect(res.isOpenNow).toBe(true);

    // 21:59 Melbourne time
    service.setClock(() => new Date('2026-11-12T10:59:00Z')); // 21:59 AEDT
    res = service.query({ date: '2026-11-12', schedule: 'venue' });
    expect(res.isOpenNow).toBe(true);

    // 22:00 Melbourne time (exclusive close)
    service.setClock(() => new Date('2026-11-12T11:00:00Z')); // 22:00 AEDT
    res = service.query({ date: '2026-11-12', schedule: 'venue' });
    expect(res.isOpenNow).toBe(false);
  });

  it('handles closed holiday dates', () => {
    const service = new HoursService();
    // Christmas Day
    service.setClock(() => new Date('2026-12-25T01:00:00Z')); // 12:00 AEDT on Dec 25
    service.validateAndApplyRows(sampleRows);

    const res = service.query({ date: '2026-12-25', schedule: 'venue' });
    expect(res.status).toBe('current');
    expect(res.closed).toBe(true);
    expect(res.isOpenNow).toBe(false);
  });

  it('returns unknown status for missing dates', () => {
    const service = new HoursService();
    service.validateAndApplyRows(sampleRows);

    const res = service.query({ date: '2026-05-01', schedule: 'venue' });
    expect(res.status).toBe('unknown');
    expect(res.closed).toBeUndefined();
    expect(res.opens).toBeUndefined();
  });

  it('handles year change across Dec 31 and Jan 1', () => {
    const service = new HoursService();
    service.validateAndApplyRows(sampleRows);

    const nye = service.query({ date: '2026-12-31', schedule: 'venue' });
    expect(nye.opens).toBe('10:00');
    expect(nye.closesNextDay).toBe(true);

    const nyd = service.query({ date: '2027-01-01', schedule: 'venue' });
    expect(nyd.opens).toBe('12:00');
    expect(nyd.closes).toBe('20:00');
  });

  it('handles Melbourne DST transitions accurately', () => {
    const service = new HoursService();
    // Melbourne standard time (AEST = UTC+10) in July
    const winterDate = new Date('2026-07-15T02:00:00Z');
    expect(service.getLocalTime(winterDate)).toBe('12:00'); // 02:00 UTC + 10h = 12:00 AEST

    // Melbourne daylight saving time (AEDT = UTC+11) in December
    const summerDate = new Date('2026-12-15T02:00:00Z');
    expect(service.getLocalTime(summerDate)).toBe('13:00'); // 02:00 UTC + 11h = 13:00 AEDT
  });

  it('evaluates overnight windows and ensures explicit closed today overrides prior overnight window', () => {
    const service = new HoursService();
    service.validateAndApplyRows([
      {
        date: '2026-11-13',
        schedule: 'venue',
        closed: false,
        opens: '10:00',
        closes: '03:00',
        closesNextDay: true,
      },
      {
        date: '2026-11-14',
        schedule: 'venue',
        closed: false,
        opens: '10:00',
        closes: '22:00',
        closesNextDay: false,
      },
      {
        date: '2026-11-15',
        schedule: 'venue',
        closed: true,
        closesNextDay: false,
      },
    ]);

    // 01:30 AM on 2026-11-14 in Melbourne: yesterday was open with closesNextDay=true at 03:00
    // 01:30 AEDT = 14:30 UTC on Nov 13
    service.setClock(() => new Date('2026-11-13T14:30:00Z'));
    let res = service.query({ schedule: 'venue' });
    expect(res.isOpenNow).toBe(true);

    // Now test overnight override: Suppose Nov 14 had overnight closing at 03:00 on Nov 15,
    // but Nov 15 is explicitly CLOSED.
    service.validateAndApplyRows([
      {
        date: '2026-11-14',
        schedule: 'venue',
        closed: false,
        opens: '10:00',
        closes: '03:00',
        closesNextDay: true,
      },
      {
        date: '2026-11-15',
        schedule: 'venue',
        closed: true,
        closesNextDay: false,
      },
    ]);

    // 01:30 AM on Nov 15 (which is closed)
    service.setClock(() => new Date('2026-11-14T14:30:00Z'));
    res = service.query({ schedule: 'venue' });
    expect(res.closed).toBe(true);
    expect(res.isOpenNow).toBe(false);
  });

  it('rejects duplicate or invalid rows and preserves previous valid snapshot', () => {
    const service = new HoursService();
    const ok = service.validateAndApplyRows(sampleRows);
    expect(ok.success).toBe(true);

    const initialSnapshot = service.getSnapshot()!;
    const initialSuccess = initialSnapshot.lastSuccessAt;

    // Duplicate entry for same date and schedule
    const duplicate = [
      { date: '2026-11-12', schedule: 'venue', closed: true, closesNextDay: false },
      { date: '2026-11-12', schedule: 'venue', closed: false, opens: '09:00', closes: '17:00', closesNextDay: false },
    ];
    const dupRes = service.validateAndApplyRows(duplicate);
    expect(dupRes.success).toBe(false);
    expect(dupRes.error).toContain('Duplicate date/schedule');

    // Invalid calendar date
    const badDate = [{ date: '2026-02-31', schedule: 'venue', closed: true, closesNextDay: false }];
    const badDateRes = service.validateAndApplyRows(badDate);
    expect(badDateRes.success).toBe(false);

    // Closed row with opens/closes specified
    const badClosed = [
      { date: '2026-11-12', schedule: 'venue', closed: true, opens: '10:00', closes: '18:00', closesNextDay: false },
    ];
    const badClosedRes = service.validateAndApplyRows(badClosed);
    expect(badClosedRes.success).toBe(false);

    // Snapshot is preserved and lastSuccessAt is unchanged
    expect(service.getSnapshot()?.lastSuccessAt).toBe(initialSuccess);
    expect(service.getSnapshot()?.rows.length).toBe(sampleRows.length);
  });

  it('marks query results as stale when snapshot age exceeds maxAgeMs', () => {
    let nowMs = 1_000_000;
    const service = new HoursService({
      maxAgeMs: 60_000,
      clock: () => new Date(nowMs),
    });
    service.validateAndApplyRows(sampleRows);

    let res = service.query({ date: '2026-11-12', schedule: 'venue' });
    expect(res.status).toBe('current');

    // Advance clock past maxAgeMs (70 seconds)
    nowMs += 70_000;
    res = service.query({ date: '2026-11-12', schedule: 'venue' });
    expect(res.status).toBe('stale');
  });

  it('restores state from saved snapshot on restart', () => {
    const service1 = new HoursService();
    service1.validateAndApplyRows(sampleRows);
    const snapshot = service1.getSnapshot()!;

    const service2 = new HoursService();
    expect(service2.query({ date: '2026-11-12', schedule: 'venue' }).status).toBe('unknown');

    service2.loadSnapshot(snapshot);
    const res = service2.query({ date: '2026-11-12', schedule: 'venue' });
    expect(res.status).toBe('current');
    expect(res.opens).toBe('09:45');
    expect(res.closes).toBe('22:00');
  });

  describe('GoogleSheetsFetcher & HoursPoller', () => {
    it('fetches and maps raw sheet values from upstream endpoint', async () => {
      const fakeFetch = vi.fn(async () => {
        return new Response(
          JSON.stringify({
            values: [
              ['date', 'schedule', 'closed', 'opens', 'closes', 'closes_next_day'],
              ['2026-11-20', 'venue', 'false', '10:00', '22:00', 'false'],
              ['2026-11-21', 'venue', 'true', '', '', 'false'],
            ],
          }),
          { status: 200 },
        );
      });

      const fetcher = new GoogleSheetsFetcher({
        sheetId: 'test-sheet-id',
        range: 'A:F',
        fetchFn: fakeFetch as any,
      });

      const rows = await fetcher.fetchRows();
      expect(rows).toHaveLength(2);
      expect(rows[0]).toEqual({
        date: '2026-11-20',
        schedule: 'venue',
        closed: false,
        opens: '10:00',
        closes: '22:00',
        closesNextDay: false,
      });
      expect(rows[1]).toEqual({
        date: '2026-11-21',
        schedule: 'venue',
        closed: true,
        opens: undefined,
        closes: undefined,
        closesNextDay: false,
      });
    });

    it('throws non-retryable error on 401 or 403 auth errors', async () => {
      const fakeFetch = vi.fn(async () => new Response('Unauthorized', { status: 401 }));
      const fetcher = new GoogleSheetsFetcher({
        sheetId: 'test-sheet-id',
        fetchFn: fakeFetch as any,
      });

      await expect(fetcher.fetchRows()).rejects.toThrow('Google Sheets auth/permission error (401)');
    });

    it('polls and applies rows to HoursService', async () => {
      const fakeFetch = vi.fn(async () => {
        return new Response(
          JSON.stringify({
            values: [
              ['date', 'schedule', 'closed', 'opens', 'closes', 'closes_next_day'],
              ['2026-11-20', 'venue', 'false', '10:00', '22:00', 'false'],
            ],
          }),
          { status: 200 },
        );
      });

      const service = new HoursService();
      const fetcher = new GoogleSheetsFetcher({
        sheetId: 'test-sheet-id',
        fetchFn: fakeFetch as any,
      });

      const poller = new HoursPoller(fetcher, (rows) => service.validateAndApplyRows(rows));
      const ok = await poller.poll();
      expect(ok).toBe(true);
      expect(service.query({ date: '2026-11-20', schedule: 'venue' }).status).toBe('current');
    });
  });
});
