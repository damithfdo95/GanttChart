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

for (const width of [420, 900, 1280, 1920]) {
  test(`sidebar and content remain usable at ${width}px`, async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(`${message.text()} ${message.location().url}`.trim());
    });
    page.on('pageerror', (error) => consoleErrors.push(error.message));

    await page.setViewportSize({ width, height: 900 });
    await page.reload();
    await expect(page.locator('main, [role="main"]')).toBeVisible();

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);

    const menu = page.locator('.sidebar-menu-toggle');
    if (width <= 900) {
      await expect(menu).toBeVisible();
      await menu.click();
      await expect(menu).toHaveAttribute('aria-expanded', 'true');
      await expect(page.locator('#app-sidebar-panel')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(menu).toHaveAttribute('aria-expanded', 'false');
      await expect(menu).toBeFocused();
    } else {
      await expect(menu).toBeHidden();
      await expect(page.locator('#app-sidebar-panel')).toBeVisible();
    }

    // Vite has no Worker API during local-mode browser tests. Startup deliberately
    // probes /api/whoami, receives 404, then selects local storage mode.
    const unexpectedErrors = consoleErrors.filter((message) => !message.includes('/api/whoami'));
    expect(unexpectedErrors).toEqual([]);
  });
}
