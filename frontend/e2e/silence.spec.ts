import { expect, test } from '@playwright/test';

test('silent caller gets a check-in, then Chloe hangs up', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Start Demo Call' }).click();
  await expect(page.getByText(/thanks for calling LeMans/i)).toBeVisible({ timeout: 30_000 });

  // ~15 s of silence after the greeting → check-in; another ~15 s → goodbye and hang-up.
  await expect(page.getByText(/still there/i)).toBeVisible({ timeout: 35_000 });
  await expect(page.getByText('Call ended')).toBeVisible({ timeout: 40_000 });
});
