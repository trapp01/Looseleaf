import { expect, test } from '@playwright/test';
import { firstRun, mod, newNotebook, newTextContainer } from './helpers.js';
import { TestServer } from './server.js';

let server: TestServer;
test.beforeAll(async () => {
  server = await TestServer.create();
});
test.afterAll(async () => {
  await server.dispose();
});

test('first run with the token, then a notebook, section and page with formatted text survive a reload', async ({ page }) => {
  await firstRun(page, server.url);
  await expect(page.getByRole('heading', { name: 'No notebooks yet' })).toBeVisible();
  await newNotebook(page, 'Work', 'Meeting notes');
  await expect(page.locator('.sections-pane .row', { hasText: 'New Section 1' })).toBeVisible();

  const editor = await newTextContainer(page, 80, 60);
  await page.keyboard.press(`${mod}+b`);
  await page.keyboard.type('Bold start');
  await page.keyboard.press(`${mod}+b`);
  await page.keyboard.type(' then plain');
  await expect(editor.locator('strong')).toHaveText('Bold start');

  await page.getByRole('button', { name: 'Add section' }).click();
  await page.keyboard.type('Second section');
  await page.keyboard.press('Enter');
  await expect(page.locator('.sections-pane .row', { hasText: 'Second section' })).toBeVisible();

  await page.reload();
  await expect(page.locator('.sync-status[data-state="synced"]')).toBeVisible();
  await page.locator('.sections-pane .row', { hasText: 'New Section 1' }).click();
  await page.locator('.pages-pane .row', { hasText: 'Meeting notes' }).click();
  await expect(page.locator('.container strong')).toHaveText('Bold start');
  await expect(page.locator('.container').first()).toContainText('Bold start then plain');
});
