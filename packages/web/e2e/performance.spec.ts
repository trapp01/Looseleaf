/**
 * A page with 200 text containers and 5,000 paragraphs, written from Node,
 * must open quickly and keep typing fast: editors mount only near the
 * viewport, and a keystroke re-renders only its own container.
 */
import { expect, test } from '@playwright/test';
import { addTextContainer, createNotebook, createPage, createSection, LIBRARY_DOC_ID, notebookDocId, pageDocId } from '@looseleaf/model';
import { firstRun } from './helpers.js';
import { seed } from './seed.js';
import { TestServer } from './server.js';

const CONTAINERS = 200;
const PARAGRAPHS_EACH = 25;
const SENTENCE = 'The quick brown fox jumps over the lazy dog while the notes keep growing line after line.';

let server: TestServer;
test.beforeAll(async () => {
  server = await TestServer.create();
  await seed(server.url, async (open) => {
    const notebookId = createNotebook(await open(LIBRARY_DOC_ID), { name: 'Big' });
    const nb = await open(notebookDocId(notebookId));
    const section = createSection(nb, { name: 'Long', parent: null });
    const pageId = createPage(nb, { section, title: 'Long page' });
    const doc = await open(pageDocId(pageId));
    doc.transact(() => {
      for (let i = 0; i < CONTAINERS; i++) {
        const content = Array.from({ length: PARAGRAPHS_EACH }, (_, j) => ({
          type: 'paragraph',
          content: [{ type: 'text', text: `Container ${i} paragraph ${j}. ${SENTENCE}` }],
        }));
        addTextContainer(doc, { x: 20 + (i % 2) * 480, y: 20 + Math.floor(i / 2) * 640, width: 440, body: { type: 'doc', content } });
      }
    });
  });
});
test.afterAll(async () => {
  await server.dispose();
});

async function measureTyping(page: import('@playwright/test').Page, text: string) {
  await page.evaluate(() => {
    const w = window as unknown as { lat: number[] };
    w.lat = [];
    window.addEventListener(
      'keydown',
      () => {
        const start = performance.now();
        requestAnimationFrame(() => setTimeout(() => w.lat.push(performance.now() - start), 0));
      },
      true,
    );
  });
  await page.keyboard.type(text, { delay: 15 });
  await page.waitForTimeout(200);
  const lat = await page.evaluate(() => (window as unknown as { lat: number[] }).lat);
  const avg = lat.reduce((a, b) => a + b, 0) / lat.length;
  const sorted = [...lat].sort((a, b) => a - b);
  return { avg, p95: sorted[Math.floor(sorted.length * 0.95)]!, max: sorted[sorted.length - 1]! };
}

test('a page with 200 containers and 5,000 paragraphs opens fast and types fast', async ({ page }) => {
  await firstRun(page, server.url);
  await page.locator('.sections-pane .row', { hasText: 'Long' }).click();
  const started = Date.now();
  await page.locator('.pages-pane .row', { hasText: 'Long page' }).click();
  await expect(page.locator('.container').first()).toContainText('paragraph 0');
  await expect(page.locator('.container')).toHaveCount(CONTAINERS);
  const openMs = Date.now() - started;
  const mounted = await page.locator('.container .ProseMirror').count();

  await page.locator('.container', { hasText: 'Container 2 paragraph 3.' }).locator('p', { hasText: 'Container 2 paragraph 3.' }).click();
  await page.keyboard.press('End');
  const top = await measureTyping(page, ' typed near the top of a very long page');
  await expect(page.locator('.container', { hasText: 'typed near the top' })).toHaveCount(1);

  await page.getByTestId('page-view').evaluate((el) => (el.scrollTop = el.scrollHeight / 2));
  const middle = page.locator('.container', { hasText: 'Container 100 paragraph 5.' }).locator('p', { hasText: 'Container 100 paragraph 5.' });
  await middle.click();
  await page.keyboard.press('End');
  const mid = await measureTyping(page, ' and more typed in the middle');
  await expect(page.locator('.container', { hasText: 'typed in the middle' })).toHaveCount(1);

  const report = { openMs, editorsMounted: mounted, top, middle: mid };
  console.log('PERF', JSON.stringify(report));
  test.info().annotations.push({ type: 'performance', description: JSON.stringify(report) });
  expect(mounted).toBeLessThan(40);
  expect(top.avg).toBeLessThan(40);
  expect(mid.avg).toBeLessThan(40);
});
