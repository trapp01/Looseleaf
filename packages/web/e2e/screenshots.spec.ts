/**
 * Screenshots for reviewing the look, written to $LOOSELEAF_SHOTS. Skipped
 * unless that is set; it asserts nothing beyond the steps working.
 */
import { expect, test, type Page } from '@playwright/test';
import { join } from 'node:path';
import { firstRun, mod, newNotebook, newTextContainer, SHOTS } from './helpers.js';
import { TestServer } from './server.js';

test.skip(!SHOTS, 'set LOOSELEAF_SHOTS to a folder to take screenshots');

let server: TestServer;
test.beforeAll(async () => {
  server = await TestServer.create();
});
test.afterAll(async () => {
  await server.dispose();
});

const shot = (page: Page, name: string) => page.screenshot({ path: join(SHOTS, `${name}.png`), animations: 'disabled' });

async function fillPage(page: Page) {
  await newNotebook(page, 'Coursework', 'Week 3 — Cell biology');
  const editor = await newTextContainer(page, 40, 40);
  await page.keyboard.press(`${mod}+Alt+1`);
  await page.keyboard.type('Cell structure');
  await page.keyboard.press('Enter');
  await page.keyboard.type('The cell membrane controls what enters and leaves the cell.');
  await page.keyboard.press('Enter');
  await page.keyboard.press(`${mod}+1`);
  await page.keyboard.type('Read chapter 4 before Thursday');
  await page.keyboard.press('Enter');
  await page.keyboard.press(`${mod}+2`);
  await page.keyboard.type('Mitochondria make most of the cell’s energy');
  await page.keyboard.press('Enter');
  await page.keyboard.press(`${mod}+2`);
  await page.keyboard.press(`${mod}+Period`);
  await page.keyboard.type('Nucleus');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Ribosomes');
  await expect(editor).toContainText('Ribosomes');
  await newTextContainer(page, 560, 60);
  await page.keyboard.press(`${mod}+3`);
  await page.keyboard.type('Why do plant cells need a cell wall?');
  await page.getByTestId('canvas').click({ position: { x: 700, y: 400 } });
  await page.locator('.pages-pane').getByRole('button', { name: 'Add page' }).click();
  await page.getByLabel('Page title').fill('Lab report draft');
  await page.locator('.pages-pane .row', { hasText: 'Week 3' }).click();
}

test('desktop, dialogs and phone', async ({ page, browser }) => {
  await page.goto(server.url);
  await expect(page.getByText('Enter the access token for this server.')).toBeVisible();
  await shot(page, '01-first-run-token');
  await firstRun(page, server.url);
  await shot(page, '02-empty-library');
  await fillPage(page);
  await page.locator('.container').first().locator('.ProseMirror, .rich-text').first().click({ position: { x: 30, y: 8 } });
  await shot(page, '03-desktop-home');
  await page.getByRole('tab', { name: 'Insert' }).click();
  await shot(page, '04-desktop-insert');
  await newTextContainer(page, 80, 520);
  await page.getByTestId('insert-table').click();
  await page.getByTestId('table-3x3').click();
  await page.keyboard.type('In a table');
  await shot(page, '04b-desktop-insert-table');
  await page.getByRole('tab', { name: 'Draw' }).click();
  await page.getByRole('button', { name: 'Pen' }).click();
  const canvas = (await page.getByTestId('canvas').boundingBox())!;
  await page.mouse.move(canvas.x + 120, canvas.y + 420);
  await page.mouse.down();
  for (let i = 0; i <= 30; i++) await page.mouse.move(canvas.x + 120 + i * 9, canvas.y + 420 + Math.sin(i / 3) * 24);
  await page.mouse.up();
  await page.getByRole('button', { name: 'Highlighter' }).click();
  await page.mouse.move(canvas.x + 40, canvas.y + 86);
  await page.mouse.down();
  await page.mouse.move(canvas.x + 300, canvas.y + 86, { steps: 10 });
  await page.mouse.up();
  await shot(page, '05-desktop-draw');
  await page.getByRole('button', { name: 'Text mode' }).click();
  await page.getByRole('tab', { name: 'View' }).click();
  await shot(page, '06-desktop-view');
  await page.getByRole('tab', { name: 'Home' }).click();
  await page.locator('.title-button', { hasText: 'Export' }).click();
  await shot(page, '07-export-dialog');
  await page.keyboard.press('Escape');
  await page.locator('.notebook-switcher').click();
  await shot(page, '08-notebook-menu');
  await page.getByRole('button', { name: 'Import from OneNote' }).click();
  await shot(page, '09-import-dialog');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Settings' }).click();
  await shot(page, '09b-settings');
  await page.keyboard.press('Escape');
  await page.locator('.rail-item[aria-label="Search"]').click();
  await page.keyboard.type('cell');
  await expect(page.locator('.result-row').first()).toBeVisible();
  await shot(page, '10-search');

  const dark = await browser.newContext({ colorScheme: 'dark', viewport: { width: 1440, height: 900 } });
  const darkPage = await dark.newPage();
  await firstRun(darkPage, server.url);
  await darkPage.locator('.pages-pane .row', { hasText: 'Week 3' }).click();
  await expect(darkPage.locator('.container', { hasText: 'Ribosomes' })).toContainText('Ribosomes');
  await shot(darkPage, '11-dark');
  await dark.close();

  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const p = await phone.newPage();
  await firstRun(p, server.url);
  await shot(p, '12-phone-sections');
  await p.locator('.sections-pane .row', { hasText: 'New Section 1' }).click();
  await shot(p, '13-phone-pages');
  await p.locator('.pages-pane .row', { hasText: 'Week 3' }).click();
  await expect(p.locator('.container', { hasText: 'Ribosomes' })).toContainText('Ribosomes');
  await shot(p, '14-phone-page');
  await phone.close();

  const desktopShell = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const d = await desktopShell.newPage();
  await d.route('**/api/info', (route) => route.abort());
  await d.goto(server.url);
  await expect(d.getByText('Where should your notes sync?')).toBeVisible();
  await shot(d, '15-first-run-choose');
  await d.getByRole('button', { name: /Connect to a server/ }).click();
  await d.getByLabel('Server address').fill('http://127.0.0.1:1');
  await d.getByLabel('Access token').fill('nope');
  await d.getByRole('button', { name: 'Connect' }).click();
  await expect(d.locator('.form-error')).not.toBeEmpty();
  await shot(d, '16-first-run-connect-error');
  await desktopShell.close();
});
