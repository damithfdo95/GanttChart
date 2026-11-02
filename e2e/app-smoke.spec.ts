import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => window.localStorage.clear());
  await page.reload();
});

test('boots the local workspace and exposes keyboard navigation', async ({ page }) => {
  await expect(page.locator('#root')).not.toBeEmpty();
  await expect(page.locator('main, [role="main"]')).toBeVisible();
  await page.waitForTimeout(500);
  await page.keyboard.press('Tab');
  const focusedTag = await page.evaluate(() => document.activeElement?.tagName ?? '');
  expect(['A', 'BUTTON', 'INPUT', 'SELECT']).toContain(focusedTag);
});

test('has no serious or critical automated accessibility violations', async ({ page }) => {
  await expect(page.locator('#root')).not.toBeEmpty();
  const results = await new AxeBuilder({ page }).analyze();
  const severe = results.violations.filter((violation) => violation.impact === 'critical' || violation.impact === 'serious');
  expect(severe).toEqual([]);
});
