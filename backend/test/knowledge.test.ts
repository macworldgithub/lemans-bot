import { describe, expect, it } from 'vitest';

import { KNOWLEDGE_DIR } from '../src/config.js';
import { loadKnowledge, loadSheets, parseSheet } from '../src/knowledge/loader.js';

describe('knowledge loader', () => {
  it('finds the header after title and note rows', () => {
    const csv = 'Title,,\n"A note only",,\nName,Price,Notes\nKids,$39,mid-week\n,,\n';
    const sheet = parseSheet(csv, { file: 'x.csv', title: 'X' });
    expect(sheet.headers).toEqual(['Name', 'Price', 'Notes']);
    expect(sheet.rows).toEqual([{ Name: 'Kids', Price: '$39', Notes: 'mid-week' }]);
  });

  it('filters rows by approval status when an explicit unapproved status is present', () => {
    const csv =
      'Activity,Min age,Approval status\n' +
      'Mini Karts,6,Approved\n' +
      'Rocket Karts,18,Unapproved\n' +
      'Sprint Karts,12,Approved\n';
    const sheet = parseSheet(csv, { file: 'activities-and-ages.csv', title: 'Activities' });
    expect(sheet.rows.map((r) => r.Activity)).toEqual(['Mini Karts', 'Sprint Karts']);
  });

  it('loads every configured sheet with rows', () => {
    const sheets = loadSheets(KNOWLEDGE_DIR);
    for (const s of sheets) expect(s.rows.length, s.file).toBeGreaterThan(0);
    const intents = sheets.find((s) => s.file === 'intents-and-answers.csv')!;
    expect(intents.rows.map((r) => r.KB_ID)).toContain('KB027'); // arrival time
    expect(intents.rows.map((r) => r.KB_ID)).toContain('KB028'); // menu
    expect(intents.rows.map((r) => r.KB_ID)).toContain('KB029'); // payment fallback
  });

  it('renders the approved facts the agent must know', () => {
    const kb = loadKnowledge(KNOWLEDGE_DIR);
    expect(kb).toContain('11-55 Waterview Close');
    expect(kb).toContain('(03) 8787 8741');
    expect(kb).toContain('$199');
    expect(kb).toContain('Zero Latency');
    expect(kb).toContain('45 minutes');
    expect(kb).toContain('lemansgokarts.com.au');
    expect(kb).toContain('lemansentertainment.com.au');

    // Provenance, destination numbers, and recording metadata stay out of the prompt
    expect(kb).not.toContain('Source:');
    expect(kb).not.toContain('Destination number:');
    expect(kb).not.toContain('.wav');

    // Transfer rules must not permit casual transfers
    expect(kb).not.toContain('Transfer Track / reservations');
  });

  it('stays small enough to live in the system prompt', () => {
    // ~4 chars per token: keep the knowledge base under ~10k tokens
    expect(loadKnowledge(KNOWLEDGE_DIR).length).toBeLessThan(40_000);
  });
});
