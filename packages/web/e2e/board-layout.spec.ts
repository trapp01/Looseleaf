/** How the board shares the window: a wide page beside the board scrolls to its right edge with Activity open or closed, and the Inbox stays at the board's left while the statuses scroll, a drag scrolling them too. */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { addBoard, addCards, addTodoLine, card, firstRun, inboxLine, newNotebook, newTextContainer, status } from './helpers.js';
import { TestServer } from './server.js';

let server: TestServer;
test.beforeAll(async () => {
  server = await TestServer.create();
});
test.afterAll(async () => {
  await server.dispose();
});

/** Scrolls the page beside the board to its right end and checks the element's right edge is in sight there, left of anything at `stop`. */
async function reachesRightEdge(page: Page, target: Locator, stop?: Locator) {
  const view = page.locator('.card-pane .page-view');
  await view.evaluate((el) => (el.scrollLeft = el.scrollWidth));
  const box = (await view.boundingBox())!;
  const right = box.x + (await view.evaluate((el) => el.clientWidth));
  const edge = (await stop?.boundingBox())?.x ?? right;
  const shown = (await target.boundingBox())!;
  expect(shown.x + shown.width).toBeLessThanOrEqual(Math.min(right, edge) + 1);
  expect(shown.x + shown.width).toBeGreaterThan(box.x);
}

test('a page wider than the pane beside the board scrolls to its right edge, with Activity beside it or over it', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await firstRun(page, server.url);
  await newNotebook(page, 'Archive', 'Wide minutes');
  await addBoard(page, 'ARC');
  await page.locator('.sections-pane .row', { hasText: 'New Section 1' }).click();
  await page.locator('.pages-pane .row', { hasText: 'Wide minutes' }).click();
  await newTextContainer(page, 60, 40);
  await page.keyboard.type('Minutes that run far past the edge of any pane, ending here');
  // Widen the container to about 1,500 px with its resize handle.
  const handle = (await page.locator('.container-resize').first().boundingBox())!;
  await page.mouse.move(handle.x + 4, handle.y + 5);
  await page.mouse.down();
  await page.mouse.move(handle.x + 1100, handle.y + 5, { steps: 10 });
  await page.mouse.up();
  await page.locator('.ribbon').getByRole('button', { name: 'Put on board' }).click();

  await page.locator('.board-row').click();
  await card(page, 'Wide minutes').click();
  const pane = page.locator('.card-pane');
  const container = pane.locator('.container').first();
  await expect(pane.getByLabel('Page title')).toHaveValue('Wide minutes');
  // The title fits the pane rather than running past it.
  const title = (await pane.getByLabel('Page title').boundingBox())!;
  const paneBox = (await pane.boundingBox())!;
  expect(title.x + title.width).toBeLessThanOrEqual(paneBox.x + paneBox.width);

  // Activity beside the page takes its room from the canvas, which still scrolls to the far edge.
  await pane.locator('.card-strip').getByRole('button', { name: 'Activity' }).click();
  const activity = pane.locator('.activity-panel');
  await expect(activity).toBeVisible();
  expect(await activity.evaluate((el) => getComputedStyle(el).position)).toBe('static');
  await reachesRightEdge(page, container, activity);
  await activity.getByRole('button', { name: 'Close activity' }).click();
  await reachesRightEdge(page, container);

  // In a narrower window the pane is too narrow for both, so Activity lies over the page until it is closed.
  await page.setViewportSize({ width: 1440, height: 900 });
  await pane.locator('.card-strip').getByRole('button', { name: 'Activity' }).click();
  await expect(activity).toBeVisible();
  expect(await activity.evaluate((el) => getComputedStyle(el).position)).toBe('absolute');
  await activity.getByRole('button', { name: 'Close activity' }).click();
  await reachesRightEdge(page, container);
});

test('the Inbox stays at the board’s left while statuses scroll, and dragging to the edge scrolls them', async ({ page }) => {
  await firstRun(page, server.url);
  await newNotebook(page, 'Yard', 'Odd jobs');
  await addBoard(page, 'YAR');
  // With no page beside it, the board view names the board and page commands are off.
  await expect(page.locator('.title-bar-title')).toHaveText('Board · Yard');
  await expect(page.locator('.ribbon').getByRole('button', { name: 'Put on board' })).toBeDisabled();
  await expect(page.locator('.ribbon').getByRole('button', { name: 'Bold' })).toBeDisabled();
  await addCards(page, 'Backlog', ['Oil the hinges']);
  await page.locator('.sections-pane .row', { hasText: 'New Section 1' }).click();
  await page.locator('.pages-pane .row', { hasText: 'Odd jobs' }).click();
  await addTodoLine(page, 'Paint the fence', 60, 40);
  await page.locator('.board-row').click();

  const board = page.getByTestId('board');
  const inbox = page.getByTestId('inbox');
  const boardBox = (await board.boundingBox())!;
  const before = (await inbox.boundingBox())!;
  await board.evaluate((el) => el.scrollTo({ left: el.scrollWidth }));
  await expect(status(page, 'Done')).toBeInViewport();
  expect((await inbox.boundingBox())!.x).toBeCloseTo(before.x, 0);
  expect(before.x).toBeLessThan(boardBox.x + 24);
  await board.evaluate((el) => el.scrollTo({ left: 0 }));
  await expect(status(page, 'Done')).not.toBeInViewport();

  // A line held at the board's right edge scrolls the statuses until Done is in reach.
  const line = inboxLine(page, 'Paint the fence');
  const from = (await line.boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 20, from.y + from.height / 2, { steps: 5 });
  await page.mouse.move(boardBox.x + boardBox.width - 6, boardBox.y + 200, { steps: 10 });
  await expect(status(page, 'Done')).toBeInViewport({ timeout: 5000 });
  await expect.poll(async () => board.evaluate((el) => el.scrollWidth - el.clientWidth - el.scrollLeft), { timeout: 5000 }).toBeLessThan(2);
  const done = (await status(page, 'Done').locator('.status-cards').boundingBox())!;
  await page.mouse.move(done.x + done.width / 2, done.y + 10, { steps: 10 });
  await page.mouse.move(done.x + done.width / 2, done.y + 12, { steps: 2 });
  await page.mouse.up();
  await expect(status(page, 'Done').locator('.card-front', { hasText: 'Paint the fence' })).toBeVisible();
  await expect(inbox).toHaveCount(0);

  // With the Inbox gone, a card dragged to the board's own left edge scrolls back.
  await page.waitForTimeout(100);
  const moved = (await card(page, 'Paint the fence').boundingBox())!;
  await page.mouse.move(moved.x + moved.width / 2, moved.y + moved.height / 2);
  await page.mouse.down();
  await page.mouse.move(moved.x + moved.width / 2 - 20, moved.y + moved.height / 2, { steps: 5 });
  await page.mouse.move(boardBox.x + 6, boardBox.y + 200, { steps: 10 });
  await expect.poll(async () => board.evaluate((el) => el.scrollLeft), { timeout: 5000 }).toBe(0);
  const backlog = (await status(page, 'Backlog').locator('.status-cards').boundingBox())!;
  await page.mouse.move(backlog.x + backlog.width / 2, backlog.y + backlog.height - 6, { steps: 10 });
  await page.mouse.move(backlog.x + backlog.width / 2, backlog.y + backlog.height - 4, { steps: 2 });
  await page.mouse.up();
  await expect(status(page, 'Backlog').locator('.card-title')).toHaveText(['Oil the hinges', 'Paint the fence']);
});
