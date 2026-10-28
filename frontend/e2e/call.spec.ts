import { expect, test } from '@playwright/test';

test('caller asks the Saturday hours, Chloe answers, then hangs up on goodbye', async ({ page, request }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Start Demo Call' }).click();

  await expect(page.getByRole('button', { name: 'End Call' })).toBeVisible();
  await expect(page.getByText('Live transcript')).toBeVisible();

  // Greeting from the agent.
  await expect(page.getByText(/thanks for calling LeMans/i)).toBeVisible({ timeout: 30_000 });

  // The fake microphone asks about Saturday ~15 s in.
  await expect(page.getByText(/open on Saturday/i)).toBeVisible({ timeout: 40_000 });

  // Answer comes from the knowledge base: Saturday 9:15am – 11pm.
  await expect(page.getByText(/(9[:.]15|nine fifteen).*(11|eleven)/i)).toBeVisible({ timeout: 30_000 });

  // The monitor API saw the same call with both sides of the conversation.
  const { calls } = await (await request.get('/api/calls')).json();
  const call = calls[0];
  expect(call.source).toBe('web');
  expect(call.lines.some((l: { role: string; text: string }) => l.role === 'user' && /saturday/i.test(l.text))).toBe(true);

  // Caller says goodbye ~14 s later; Chloe says bye and ends the call herself (end_call tool).
  await expect(page.getByText('Call ended')).toBeVisible({ timeout: 45_000 });
  await expect(page.getByRole('button', { name: 'Start Demo Call' })).toBeVisible();

  // The caller must hear a goodbye before the line drops: the last line is Chloe's.
  const after = await (await request.get('/api/calls')).json();
  const lines: { role: string; text: string }[] = after.calls[0].lines;
  expect(lines.at(-1)?.role).toBe('bot');
  expect(lines.at(-1)?.text.trim().length).toBeGreaterThan(3);
});
