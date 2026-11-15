/** Two browser contexts are two replicas of one server. */
import { expect, test, type Browser, type Page, type WebSocketRoute } from '@playwright/test';
import { deflateSync } from 'node:zlib';
import { firstRun, mod, newNotebook, newTextContainer } from './helpers.js';
import { TestServer } from './server.js';

let server: TestServer;
test.beforeEach(async () => {
  server = await TestServer.create();
});
test.afterEach(async () => {
  await server.dispose();
});

/**
 * A browser context on the server. Offline emulation does not close an open
 * WebSocket, so the sync socket is routed through the test and `offline`
 * drops it and refuses new ones as well as cutting the network.
 */
async function replica(browser: Browser, { routed = false } = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  let cut = false;
  const sockets = new Set<WebSocketRoute>();
  if (routed) await context.routeWebSocket(/\/sync$/, (ws) => {
    if (cut) return void ws.close();
    ws.connectToServer();
    sockets.add(ws);
    ws.onClose(() => sockets.delete(ws));
  });
  const page = await context.newPage();
  await firstRun(page, server.url);
  const offline = async (value: boolean) => {
    cut = value;
    await context.setOffline(value);
    if (value) for (const ws of [...sockets]) await ws.close();
  };
  return { context, page, offline };
}

async function openPage(page: Page, section: string, title: string) {
  await page.locator('.sections-pane .row', { hasText: section }).click();
  await page.locator('.pages-pane .row', { hasText: title }).click();
  await expect(page.getByLabel('Page title')).toHaveValue(title);
}

/** A 2 × 2 PNG, red. */
function png(): Buffer {
  const crc = (buf: Buffer) => {
    let c = ~0;
    for (const b of buf) {
      c ^= b;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.from([0, 0, 0, 2, 0, 0, 0, 2, 8, 2, 0, 0, 0]);
  const raw = Buffer.from([0, 255, 0, 0, 255, 0, 0, 0, 255, 0, 0, 255, 0, 0]);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

test('a second replica sees edits, and offline edits to the same paragraph and new pages converge', async ({ browser }) => {
  const a = await replica(browser, { routed: true });
  await newNotebook(a.page, 'Shared', 'Common page');
  await newTextContainer(a.page, 60, 40);
  await a.page.keyboard.type('Start.');
  const b = await replica(browser, { routed: true });
  await openPage(b.page, 'New Section 1', 'Common page');
  await expect(b.page.locator('.container')).toContainText('Start.');

  await a.offline(true);
  await b.offline(true);
  await expect(a.page.locator('.sync-status[data-state="offline"]')).toBeVisible({ timeout: 20_000 });
  await expect(b.page.locator('.sync-status[data-state="offline"]')).toBeVisible({ timeout: 20_000 });

  for (const [r, words, title] of [
    [a, ' From A.', 'Page from A'],
    [b, ' From B.', 'Page from B'],
  ] as const) {
    await r.page.locator('.container p', { hasText: 'Start.' }).click();
    await r.page.keyboard.press('End');
    await r.page.keyboard.type(words);
    await r.page.locator('.pages-pane').getByRole('button', { name: 'Add page' }).click();
    await r.page.getByLabel('Page title').fill(title);
    await r.page.locator('.pages-pane .row', { hasText: 'Common page' }).click();
  }

  await a.offline(false);
  await b.offline(false);
  for (const r of [a, b]) await expect(r.page.locator('.sync-status[data-state="synced"]')).toBeVisible({ timeout: 20_000 });

  const texts: string[] = [];
  for (const r of [a, b]) {
    await expect(r.page.locator('.pages-pane .row', { hasText: 'Page from A' })).toBeVisible();
    await expect(r.page.locator('.pages-pane .row', { hasText: 'Page from B' })).toBeVisible();
    const paragraph = r.page.locator('.container p', { hasText: 'Start.' });
    await expect(paragraph).toContainText('From A.');
    await expect(paragraph).toContainText('From B.');
    texts.push((await paragraph.textContent())!);
  }
  expect(texts[0]).toBe(texts[1]);
  await a.context.close();
  await b.context.close();
});

test('the status goes offline when the server stops and back to synced when it returns', async ({ browser }) => {
  const a = await replica(browser);
  await newNotebook(a.page, 'Resilient', 'Before restart');
  await server.stop();
  await expect(a.page.locator('.sync-status[data-state="offline"]')).toBeVisible({ timeout: 20_000 });
  await expect(a.page.locator('.sync-status')).toContainText('Offline');
  await newTextContainer(a.page, 60, 40);
  await a.page.keyboard.type('Written while the server was away.');
  await server.start();
  await expect(a.page.locator('.sync-status[data-state="synced"]')).toBeVisible({ timeout: 40_000 });
  const b = await replica(browser);
  await openPage(b.page, 'New Section 1', 'Before restart');
  await expect(b.page.locator('.container')).toContainText('Written while the server was away.', { timeout: 30_000 });
  await a.context.close();
  await b.context.close();
});

test('tags, a table and a picture reach the second replica', async ({ browser }) => {
  const a = await replica(browser);
  await newNotebook(a.page, 'Rich', 'Rich page');
  await newTextContainer(a.page, 60, 40);
  await a.page.keyboard.press(`${mod}+1`);
  await a.page.keyboard.type('Buy milk');
  await a.page.keyboard.press('Enter');
  await a.page.keyboard.press(`${mod}+2`);
  await a.page.keyboard.type('Important thing');
  await a.page.keyboard.press('Enter');
  await a.page.keyboard.press(`${mod}+2`);
  await a.page.getByRole('tab', { name: 'Insert' }).click();
  await a.page.getByTestId('insert-table').click();
  await a.page.getByTestId('table-2x3').click();
  await a.page.keyboard.type('cell one');
  await a.page.keyboard.press('Tab');
  await a.page.keyboard.type('cell two');
  const chooser = a.page.waitForEvent('filechooser');
  await a.page.getByRole('button', { name: 'Picture' }).click();
  await (await chooser).setFiles({ name: 'red.png', mimeType: 'image/png', buffer: png() });
  await expect(a.page.locator('.container .inline-picture[data-state="ready"] img')).toBeVisible();
  // The To Do box toggles when pressed.
  const todo = a.page.locator('.container p[data-tag="todo"]');
  const box = (await todo.boundingBox())!;
  await a.page.mouse.click(box.x + 8, box.y + box.height / 2);
  await expect(todo).toHaveAttribute('data-checked', 'true');

  const b = await replica(browser);
  await openPage(b.page, 'New Section 1', 'Rich page');
  const container = b.page.locator('.container').first();
  await expect(container.locator('[data-tag="todo"][data-checked="true"]')).toHaveText('Buy milk');
  await expect(container.locator('[data-tag="important"]')).toHaveText('Important thing');
  await expect(container.locator('table tr')).toHaveCount(2);
  await expect(container.locator('table td').first()).toHaveText('cell one');
  await expect(container.locator('table td').nth(1)).toHaveText('cell two');
  await expect(container.locator('img')).toBeVisible();
  await expect.poll(() => container.locator('img').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(2);
  await a.context.close();
  await b.context.close();
});
