import { readFileSync } from 'node:fs';
import path from 'node:path';

import { parse } from 'csv-parse/sync';

export interface Sheet {
  file: string;
  title: string;
  headers: string[];
  rows: Record<string, string>[];
}

interface SheetSpec {
  file: string;
  title: string;
  /** Columns the agent does not need (provenance, owners). */
  omit?: string[];
}

// Order matters: the model reads the prompt top-down, most-used sheets first.
// how-to-use.csv (meta) and call-archive-index.csv (recording filenames) are not answers.
export const SHEETS: SheetSpec[] = [
  { file: 'business-profile.csv', title: 'Business profile', omit: ['Source'] },
  { file: 'intents-and-answers.csv', title: 'Intents and approved answers' },
  { file: 'packages-and-prices.csv', title: 'Packages and published prices' },
  { file: 'activities-and-ages.csv', title: 'Activity rules (ages, limits, medical)' },
  { file: 'booking-and-payments.csv', title: 'Booking, payment, waiver and catering rules' },
  { file: 'transfer-rules.csv', title: 'Transfer and escalation rules', omit: ['Destination number'] },
  { file: 'open-questions.csv', title: 'Unconfirmed facts (do not state these as fact)', omit: ['Owner'] },
];

const cell = (v: unknown) => String(v ?? '').replace(/\s+/g, ' ').trim();

/**
 * Parses one exported sheet. Exports start with a title row and sometimes a note row
 * (a single filled cell); the header is the first row with two or more filled cells.
 */
export function parseSheet(csv: string, spec: SheetSpec): Sheet {
  const records: string[][] = parse(csv, { relaxColumnCount: true, skipEmptyLines: true, bom: true });
  const rows = records.map((r) => r.map(cell));
  const headerIdx = rows.findIndex((r) => r.filter(Boolean).length >= 2);
  if (headerIdx < 0) throw new Error(`${spec.file}: no header row found`);

  const headers = rows[headerIdx].filter(Boolean);
  const data = rows
    .slice(headerIdx + 1)
    .filter((r) => r.filter(Boolean).length >= 2)
    .map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ''])));

  return { file: spec.file, title: spec.title, headers, rows: data };
}

export function loadSheets(dir: string): Sheet[] {
  return SHEETS.map((spec) => parseSheet(readFileSync(path.join(dir, spec.file), 'utf8'), spec));
}

/** Renders sheets as compact "Header: value" lines, skipping empty cells and omitted columns. */
export function renderKnowledge(sheets: Sheet[]): string {
  return sheets
    .map((sheet) => {
      const omit = new Set(SHEETS.find((s) => s.file === sheet.file)?.omit ?? []);
      const lines = sheet.rows.map(
        (row) =>
          '- ' +
          sheet.headers
            .filter((h) => !omit.has(h) && row[h])
            .map((h) => `${h}: ${row[h]}`)
            .join(' | '),
      );
      return `## ${sheet.title}\n${lines.join('\n')}`;
    })
    .join('\n\n');
}

export function loadKnowledge(dir: string): string {
  return renderKnowledge(loadSheets(dir));
}
