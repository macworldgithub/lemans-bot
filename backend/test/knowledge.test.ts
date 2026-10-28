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

  it('loads every configured sheet with rows', () => {
    const sheets = loadSheets(KNOWLEDGE_DIR);
    for (const s of sheets) expect(s.rows.length, s.file).toBeGreaterThan(0);
    const intents = sheets.find((s) => s.file === 'intents-and-answers.csv')!;
    expect(intents.rows.map((r) => r.KB_ID)).toContain('KB026');
  });

  it('renders the facts the agent must know', () => {
    const kb = loadKnowledge(KNOWLEDGE_DIR);
    expect(kb).toContain('55 Waterview Close');
    expect(kb).toContain('(03) 8787 8741');
    expect(kb).toContain('$199');
    expect(kb).toContain('Zero Latency');
    // Provenance and recording metadata stay out of the prompt.
    expect(kb).not.toContain('Source:');
    expect(kb).not.toContain('.wav');
  });

  it('stays small enough to live in the system prompt', () => {
    // ~4 chars per token: keep the knowledge base under ~10k tokens.
    expect(loadKnowledge(KNOWLEDGE_DIR).length).toBeLessThan(40_000);
  });
});
