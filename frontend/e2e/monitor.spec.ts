import { expect, test } from '@playwright/test';

// Runs after call.spec.ts: the monitor should list that call with its transcript.
test('monitor shows recent calls with transcripts', async ({ page }) => {
  await page.goto('/monitor');
  await expect(page.getByText('Live', { exact: true })).toBeVisible();

  const latest = page.getByRole('button', { name: /Web/ }).first();
  await expect(latest).toBeVisible();
  await latest.click();

  await expect(page.getByText(/open on Saturday/i).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Download' })).toBeEnabled();
  await page.screenshot({ path: 'test-results/monitor.png', fullPage: true });
});
