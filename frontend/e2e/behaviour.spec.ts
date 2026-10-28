import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

// Spoken behaviour checks, one recorded caller per Playwright project (see playwright.config.ts).
// They run against whichever pipeline the agent uses, and are the only behaviour tests for
// GPT-Live, which cannot run the text-only tests in backend/test/agent.

interface Line {
  role: 'bot' | 'user';
  text: string;
  interrupted?: boolean;
}

/** Starts a demo call, waits for the greeting, then for Chloe to hang up. Returns the transcript. */
async function runCall(page: Page, request: APIRequestContext): Promise<Line[]> {
  await page.goto('/');
  await page.getByRole('button', { name: 'Start Demo Call' }).click();
  await expect(page.getByText(/thanks for calling LeMans/i)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('Call ended')).toBeVisible({ timeout: 120_000 });
  const { calls } = await (await request.get('/api/calls')).json();
  // Realtime models write curly apostrophes ("can’t"); normalise them for the checks below.
  const lines: Line[] = calls[0].lines.map((l: Line) => ({ ...l, text: l.text.replace(/[‘’]/g, "'") }));
  console.log(lines.map((l) => `${l.role === 'bot' ? 'Chloe' : 'Caller'}${l.interrupted ? ' (cut off)' : ''}: ${l.text}`).join('\n'));
  // The caller always hears a goodbye before the line drops.
  expect(lines.at(-1)?.role).toBe('bot');
  return lines;
}

const botText = (lines: Line[]) =>
  lines
    .filter((l) => l.role === 'bot')
    .map((l) => l.text)
    .join(' ');

const forProject = (name: string) =>
  test.beforeEach(({}, info) => test.skip(info.project.name !== name, `runs in ${name}`));

test.describe('kids party price', () => {
  forProject('caller-kids-price');
  test('quotes the published kids party price and hangs up on goodbye', async ({ page, request }) => {
    const lines = await runCall(page, request);
    expect(botText(lines)).toMatch(/(\$?39|thirty[- ]nine|\$?49|forty[- ]nine)/i);
  });
});

test.describe('corporate enquiry', () => {
  forProject('caller-corporate');
  test('never quotes a corporate rate, then transfers or offers a callback', async ({ page, request }) => {
    const lines = await runCall(page, request);
    expect(botText(lines)).not.toMatch(/\$\s?\d|\b\d+ dollars|dollars a head/i);
    // During office hours Chloe transfers; when the office is closed she may offer a callback instead.
    const transferred = (await page.getByText(/Transfer requested/i).count()) > 0;
    expect(transferred || /call (you )?back|callback/i.test(botText(lines))).toBe(true);
  });
});

test.describe('medical question', () => {
  forProject('caller-pregnant');
  test('does not clear a pregnant caller to race', async ({ page, request }) => {
    const lines = await runCall(page, request);
    const reply = lines.find((l, i) => l.role === 'bot' && i > 0 && /pregnan/i.test(lines[i - 1]?.text ?? ''))?.text ?? botText(lines);
    expect(reply).toMatch(/(can't|cannot|not able|unable|not allowed|not permitted|unfortunately|sorry|restrict|isn't|aren't)/i);
    expect(reply).not.toMatch(/\b(yes,? you can|that's fine|no problem)\b/i);
  });
});

test.describe('callback lead', () => {
  forProject('caller-lead');
  test('takes the caller details and saves a callback lead', async ({ page, request }) => {
    const callDone = runCall(page, request);
    await expect(page.getByText(/Lead saved/i)).toBeVisible({ timeout: 100_000 });
    await expect(page.getByText(/Jake/).first()).toBeVisible();
    await callDone;
    const { calls } = await (await request.get('/api/calls')).json();
    const lead = calls[0].leads[0];
    expect(lead.name).toMatch(/jake/i);
    expect(String(lead.phone ?? '').replace(/\D/g, '')).toMatch(/0?412345678$/);
  });
});

test.describe('barge-in', () => {
  forProject('caller-interrupt');
  test('stops talking when the caller interrupts and answers the new question', async ({ page, request }) => {
    const lines = await runCall(page, request);
    // Chloe starts a long overview of every activity; the caller cuts in. Her reply to the first
    // question must be cut short: flagged as interrupted (cascade) or only a sentence or two
    // long (GPT-Live transcribes only what was played and does not flag it).
    const first = lines.findIndex((l) => l.role === 'user' && /activities/i.test(l.text));
    const reply = lines.slice(first + 1).find((l) => l.role === 'bot');
    expect(reply?.interrupted || (reply?.text.split(/\s+/).length ?? 99) <= 20).toBe(true);
    // Go-kart minimum age is in the knowledge base; any age figure counts as answering.
    expect(botText(lines)).toMatch(/\b(\d{1,2}|sixteen|eighteen)\b[ -]*(\+|plus|years?|or older|cm)/i);
  });
});
