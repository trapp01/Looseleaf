/** A board at phone width: sections to the board, one column per screen with the Inbox first, the line menu from the pill, a card's page with its strip, and Activity as a sheet. */
import { expect, test } from '@playwright/test';
import { addBoard, addCards, addTodoLine, card, firstRun, inboxLine, newNotebook, status } from './helpers.js';
import { TestServer } from './server.js';

let server: TestServer;
test.beforeAll(async () => {
  server = await TestServer.create();
});
test.afterAll(async () => {
  await server.dispose();
});

test('sections, board, card and page on a phone', async ({ browser }) => {
  // Set up on a wide screen, then open the same server on a phone.
  const desk = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const deskPage = await desk.newPage();
  await firstRun(deskPage, server.url);
  await newNotebook(deskPage, 'Shed', 'Shed list');
  await addBoard(deskPage, 'SHE');
  await addCards(deskPage, 'Backlog', ['Fix the gate']);
  await deskPage.locator('.sections-pane .row', { hasText: 'New Section 1' }).click();
  await deskPage.locator('.pages-pane .row', { hasText: 'Shed list' }).click();
  await addTodoLine(deskPage, 'Sweep the yard', 60, 40);
  await deskPage.locator('.board-row').click();
  await expect(inboxLine(deskPage, 'Sweep the yard')).toBeVisible();
  await desk.close();

  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await phone.newPage();
  await firstRun(page, server.url);

  // Sections list with the Board row; the board shows one column per screen, the Inbox first, and scrolls sideways.
  await page.locator('.board-row').click();
  await expect(page.locator('.phone-title')).toHaveText('Board');
  const inbox = page.getByTestId('inbox');
  await expect(inboxLine(page, 'Sweep the yard')).toBeVisible();
  const lane = (await inbox.boundingBox())!;
  expect(lane.x).toBeGreaterThanOrEqual(0);
  expect(lane.width).toBeGreaterThan(390 - 60);
  // The next column only peeks in at the edge.
  await expect(status(page, 'Backlog')).not.toBeInViewport({ ratio: 0.5 });
  await page.getByTestId('board').evaluate((board) => board.scrollBy({ left: board.clientWidth }));
  await expect(status(page, 'Backlog')).toBeInViewport({ ratio: 0.9 });
  await expect(inbox).not.toBeInViewport({ ratio: 0.5 });
  // Touch targets on the line are at least 44 px.
  await page.getByTestId('board').evaluate((board) => board.scrollTo({ left: 0 }));
  expect((await inboxLine(page, 'Sweep the yard').locator('.inbox-source').boundingBox())!.height).toBeGreaterThanOrEqual(44);
  expect((await inboxLine(page, 'Sweep the yard').getByRole('button', { name: 'Line actions' }).boundingBox())!.height).toBeGreaterThanOrEqual(44);

  // The line's page opens full screen; its pill opens the line menu.
  await inboxLine(page, 'Sweep the yard').locator('.inbox-source').click();
  await expect(page.locator('.phone-title')).toHaveText('Shed list');
  await expect(page.getByTestId('board')).toBeHidden();
  await page.locator('.rich-text [data-tag="todo"] .inbox-pill').click();
  await page.getByRole('menuitem', { name: 'Backlog' }).click();
  await expect(page.locator('.rich-text span[data-card-link]')).toContainText('SHE-2');
  await page.getByRole('button', { name: 'Back to board' }).click();
  await expect(status(page, 'Backlog').locator('.card-front')).toHaveCount(2);

  // A card opens its page with the strip; Activity opens as a sheet over it.
  await page.getByTestId('board').evaluate((board) => board.scrollBy({ left: board.clientWidth }));
  await card(page, 'Fix the gate').click();
  await expect(page.locator('.phone-title')).toHaveText('Fix the gate');
  await expect(page.locator('.card-strip .card-ref')).toHaveText('SHE-1');
  await page.locator('.card-strip').getByRole('button', { name: 'Activity' }).click();
  const sheet = page.locator('.activity-panel');
  await expect(sheet).toBeVisible();
  expect(await sheet.evaluate((el) => getComputedStyle(el).position)).toBe('fixed');
  await sheet.getByRole('button', { name: 'Close' }).click();
  await expect(sheet).toHaveCount(0);
  await page.getByRole('button', { name: 'Back to board' }).click();
  await page.getByRole('button', { name: 'Back to sections' }).click();
  await expect(page.locator('.board-row')).toBeVisible();
  await phone.close();
});
