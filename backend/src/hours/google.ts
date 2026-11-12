export interface GoogleFetcherOptions {
  sheetId?: string;
  range?: string;
  accessToken?: string;
  baseUrl?: string;
  fetchFn?: typeof fetch;
}

export interface SheetRowObject {
  date: string;
  schedule: string;
  closed: boolean;
  opens?: string;
  closes?: string;
  closesNextDay: boolean;
}

function parseBoolean(val: unknown): boolean {
  if (typeof val === 'boolean') return val;
  if (!val) return false;
  const s = String(val).trim().toLowerCase();
  return s === 'true' || s === '1' || s === 'yes';
}

function serialDateToIso(serial: number): string {
  // Google Sheets / Excel epoch starts Dec 30, 1899
  const utcDays = Math.floor(serial - 25569);
  const date = new Date(utcDays * 86400 * 1000);
  return date.toISOString().slice(0, 10);
}

export class GoogleSheetsFetcher {
  readonly sheetId?: string;
  readonly range: string;
  readonly accessToken?: string;
  readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;

  constructor(options: GoogleFetcherOptions = {}) {
    this.sheetId = options.sheetId;
    this.range = options.range ?? 'A:F';
    this.accessToken = options.accessToken;
    this.baseUrl = options.baseUrl ?? 'https://sheets.googleapis.com/v4/spreadsheets';
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async fetchRows(): Promise<SheetRowObject[]> {
    if (!this.sheetId) {
      throw new Error('HOURS_SHEET_ID is not configured');
    }

    const url = `${this.baseUrl}/${encodeURIComponent(this.sheetId)}/values/${encodeURIComponent(this.range)}`;
    const headers: Record<string, string> = {
      accept: 'application/json',
    };
    if (this.accessToken) {
      headers.authorization = `Bearer ${this.accessToken}`;
    }

    const res = await this.fetchFn(url, {
      headers,
      signal: AbortSignal.timeout(5000),
    });

    if (res.status === 400 || res.status === 401 || res.status === 403) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Google Sheets auth/permission error (${res.status}): ${errText}`);
    }

    if (!res.ok) {
      throw new Error(`Google Sheets API error: HTTP ${res.status}`);
    }

    const data = (await res.json()) as { values?: unknown[][] };
    if (!data.values || data.values.length < 2) {
      return [];
    }

    const [headerRow, ...dataRows] = data.values;
    const headersList = (headerRow as string[]).map((h) => String(h ?? '').toLowerCase().trim());

    const dateIdx = headersList.indexOf('date');
    const schedIdx = headersList.indexOf('schedule');
    const closedIdx = headersList.indexOf('closed');
    const opensIdx = headersList.indexOf('opens');
    const closesIdx = headersList.indexOf('closes');
    const nextDayIdx = headersList.findIndex((h) => h === 'closes_next_day' || h === 'closesnextday');

    if (dateIdx === -1 || schedIdx === -1 || closedIdx === -1) {
      throw new Error('Google Sheet missing required columns: date, schedule, closed');
    }

    const result: SheetRowObject[] = [];
    for (const r of dataRows) {
      if (!r || r.length === 0) continue;
      let rawDate = r[dateIdx];
      let dateStr = '';
      if (typeof rawDate === 'number') {
        dateStr = serialDateToIso(rawDate);
      } else {
        dateStr = String(rawDate ?? '').trim();
      }

      if (!dateStr) continue;

      const schedule = String(r[schedIdx] ?? '').trim().toLowerCase();
      const closed = parseBoolean(r[closedIdx]);
      const opens = opensIdx !== -1 && r[opensIdx] ? String(r[opensIdx]).trim() : undefined;
      const closes = closesIdx !== -1 && r[closesIdx] ? String(r[closesIdx]).trim() : undefined;
      const closesNextDay = nextDayIdx !== -1 ? parseBoolean(r[nextDayIdx]) : false;

      result.push({
        date: dateStr,
        schedule,
        closed,
        opens: closed ? undefined : opens,
        closes: closed ? undefined : closes,
        closesNextDay,
      });
    }

    return result;
  }
}

export class HoursPoller {
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly fetcher: GoogleSheetsFetcher,
    private readonly onRowsReceived: (rows: unknown[]) => { success: boolean; error?: string },
    private readonly intervalMs: number = 300_000,
  ) {}

  start(): void {
    if (this.timer) return;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async poll(): Promise<boolean> {
    if (this.running) return false;
    this.running = true;
    try {
      const rows = await this.fetcher.fetchRows();
      const outcome = this.onRowsReceived(rows);
      return outcome.success;
    } catch {
      return false;
    } finally {
      this.running = false;
    }
  }
}
