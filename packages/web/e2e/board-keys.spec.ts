/** The board's search box, its single-key shortcuts, Escape on the open card, and copying a card's ref from the strip. */
import { expect, test } from '@playwright/test';
import { addBoard, addCards, card, firstRun, newNotebook, status } from './helpers.js';
import { TestServer } from './server.js';

let server: TestServer;
test.beforeAll(async () => {
  server = await TestServer.create();
});
test.afterAll(async () => {
  await server.dispose();
});

test('search, shortcuts, Escape and copy ref', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await firstRun(page, server.url);
  await newNotebook(page, 'Workshop', 'Bench notes');
  await addBoard(page, 'WOR');
  await addCards(page, 'Backlog', ['Oil the bench', 'Sharpen the plane', 'Sweep the floor']);

  // `/` focuses the search box; words narrow the board and Escape clears them.
  await page.keyboard.press('/');
  const search = page.getByLabel('Search cards');
  await expect(search).toBeFocused();
  await page.keyboard.type('plane');
  await expect(page.locator('.card-front')).toHaveCount(1);
  await expect(page.locator('.filter-count')).toHaveText('1 of 3 cards');
  await search.press('Escape');
  await expect(page.locator('.card-front')).toHaveCount(3);
  await search.press('Escape');
  await expect(search).not.toBeFocused();

  // `n` opens the composer in the status under the pointer.
  await status(page, 'This week').locator('.status-header').hover();
  await page.keyboard.press('n');
  await expect(status(page, 'This week').getByLabel('Card title')).toBeFocused();
  await status(page, 'This week').getByLabel('Card title').press('Escape');

  // Enter opens the card under the pointer; Escape closes it again.
  await card(page, 'Oil the bench').hover();
  await page.keyboard.press('Enter');
  const pane = page.locator('.card-pane');
  await expect(pane.getByLabel('Page title')).toHaveValue('Oil the bench');

  // The strip copies the card's ref.
  await pane.getByRole('button', { name: 'Copy ref' }).click();
  await expect(page.locator('.toast')).toHaveText('Copied WOR-1');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('WOR-1');
  await page.keyboard.press('Escape');
  await expect(pane).toHaveCount(0);

  // `c` archives the card under the pointer, with Undo; `?` lists the shortcuts.
  await card(page, 'Sweep the floor').hover();
  await page.keyboard.press('c');
  await expect(card(page, 'Sweep the floor')).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(card(page, 'Sweep the floor')).toBeVisible();
  await page.keyboard.press('?');
  const list = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(list).toContainText('Search the cards on this board');
  await page.keyboard.press('Escape');
  await expect(list).toHaveCount(0);
});
