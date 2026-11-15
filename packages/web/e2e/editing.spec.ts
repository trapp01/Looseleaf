/** Canvas editing, the phone drill-down, export and import, each against a real server. */
import { expect, test } from '@playwright/test';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSectionFile } from '../../onenote/test/section-fixture.js';
import { firstRun, mod, newNotebook, newTextContainer } from './helpers.js';
import { TestServer } from './server.js';

let server: TestServer;
test.beforeAll(async () => {
  server = await TestServer.create();
});
test.afterAll(async () => {
  await server.dispose();
});

test('dragging a container moves it and undo puts it back', async ({ page }) => {
  await firstRun(page, server.url);
  await newNotebook(page, 'Drag', 'Drag page');
  await newTextContainer(page, 60, 40);
  await page.keyboard.type('Move me');
  const container = page.locator('.container', { hasText: 'Move me' });
  const before = await container.evaluate((el: HTMLElement) => [el.style.left, el.style.top]);
  const bar = container.getByTestId('container-bar');
  await container.hover();
  const box = (await bar.boundingBox())!;
  await page.mouse.move(box.x + 20, box.y + 4);
  await page.mouse.down();
  await page.mouse.move(box.x + 120, box.y + 64, { steps: 6 });
  await page.mouse.move(box.x + 220, box.y + 124, { steps: 6 });
  await page.mouse.up();
  const moved = [`${parseFloat(before[0]!) + 200}px`, `${parseFloat(before[1]!) + 120}px`];
  await expect.poll(() => container.evaluate((el: HTMLElement) => [el.style.left, el.style.top])).toEqual(moved);
  await page.locator('.title-bar').getByRole('button', { name: /Undo/ }).click();
  await expect.poll(() => container.evaluate((el: HTMLElement) => [el.style.left, el.style.top])).toEqual(before);
  await page.keyboard.press(`${mod}+Shift+z`);
  await expect.poll(() => container.evaluate((el: HTMLElement) => el.style.left)).toBe(moved[0]);
  // Undo also covers typing: the text goes, then the container itself.
  await page.keyboard.press(`${mod}+z`);
  await page.keyboard.press(`${mod}+z`);
  await expect(page.locator('.container', { hasText: 'Move me' })).toHaveCount(0);
});

test('phone: sections, then pages, then the page, typing, and back', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  await firstRun(page, server.url);
  if (await page.getByRole('heading', { name: 'No notebooks yet' }).isVisible()) {
    await page.getByRole('button', { name: 'New notebook' }).click();
    await page.getByLabel('Name').fill('Pocket');
    await page.getByRole('button', { name: 'Create notebook' }).click();
    await page.getByRole('button', { name: 'Back to sections' }).click();
  }
  await expect(page.locator('.sections-pane')).toBeVisible();
  await page.locator('.sections-pane .row').first().tap();
  await expect(page.locator('.pages-pane')).toBeVisible();
  await page.getByRole('button', { name: 'Add page' }).tap();
  await expect(page.locator('.phone-page')).toBeVisible();
  await page.getByLabel('Page title').fill('Phone page');
  await page.getByTestId('canvas').tap({ position: { x: 30, y: 30 } });
  await expect(page.locator('.container .ProseMirror-focused')).toBeVisible();
  await page.keyboard.type('Typed on a phone');
  await page.locator('.format-bar').getByRole('button', { name: 'Bold' }).tap();
  await page.keyboard.type(' bold');
  await expect(page.locator('.container strong')).toHaveText(' bold');
  await page.getByRole('button', { name: 'Back to pages' }).tap();
  await expect(page.locator('.pages-pane .row', { hasText: 'Phone page' })).toBeVisible();
  await page.locator('.pages-pane .row', { hasText: 'Phone page' }).tap();
  await expect(page.locator('.container')).toContainText('Typed on a phone bold');
  await context.close();
});

test('export a page as HTML and as Markdown', async ({ page }) => {
  await firstRun(page, server.url);
  await newNotebook(page, 'Exports', 'Export me');
  await newTextContainer(page, 60, 40);
  await page.keyboard.press(`${mod}+b`);
  await page.keyboard.type('Strong words');
  await page.keyboard.press(`${mod}+b`);
  await page.keyboard.type(' and plain ones');
  await page.locator('.title-button', { hasText: 'Export' }).click();
  for (const [format, name, expected] of [
    ['HTML', 'Export me.html', '<strong>Strong words</strong>'],
    ['Markdown', 'Export me.md', '**Strong words** and plain ones'],
  ] as const) {
    await page.getByRole('radio', { name: 'This page' }).check();
    await page.getByRole('radio', { name: format }).click();
    const download = page.waitForEvent('download');
    await page.getByTestId('export-go').click();
    const file = await download;
    expect(file.suggestedFilename()).toBe(name);
    const text = await readFile((await file.path())!, 'utf8');
    expect(text).toContain(expected);
    expect(text).toContain('Export me');
    if (format === 'HTML') await page.locator('.title-button', { hasText: 'Export' }).click();
  }
});

test('import a OneNote section file', async ({ page }) => {
  const dir = await mkdtemp(join(tmpdir(), 'looseleaf-import-'));
  const file = join(dir, 'Lecture notes.one');
  await writeFile(
    file,
    buildSectionFile([
      { title: 'First lecture', paragraphs: ['Welcome to the course', 'Reading list'] },
      { title: 'Follow-up', paragraphs: ['Questions from class'], pageLevel: 2 },
    ]),
  );
  await firstRun(page, server.url);
  await page.locator('.notebook-switcher').click();
  await page.getByRole('button', { name: 'Import from OneNote' }).click();
  await page.getByTestId('import-file-input').setInputFiles(file);
  const report = page.getByTestId('import-report');
  await expect(report).toBeVisible();
  await expect(report.locator('.report-totals')).toContainText('Sections1');
  await expect(report.locator('.report-totals')).toContainText('Pages2');
  await page.getByRole('button', { name: 'Open notebook' }).click();
  await expect(page.locator('.notebook-name')).toHaveText('Imported notes');
  await page.locator('.sections-pane .row', { hasText: 'Lecture notes' }).click();
  await page.locator('.pages-pane .row', { hasText: 'First lecture' }).click();
  await expect(page.locator('.container')).toContainText('Welcome to the course');
  await expect(page.locator('.pages-pane .row', { hasText: 'Follow-up' })).toHaveCSS('padding-left', '32px');
});
