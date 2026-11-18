/** The board as a pane beside the page in the notebook view: a line becomes a card without leaving the page, a card opened from it becomes the page shown, and the pane's width and the choice to show it are kept on the device. */
import { expect, test } from '@playwright/test';
import { addBoard, addTodoLine, card, dragTo, firstRun, inboxLine, newNotebook, status } from './helpers.js';
import { TestServer } from './server.js';

let server: TestServer;
test.beforeAll(async () => {
  server = await TestServer.create();
});
test.afterAll(async () => {
  await server.dispose();
});

test('the board beside a page', async ({ page }) => {
  await firstRun(page, server.url);
  await newNotebook(page, 'Studio', 'Practice log');
  await addBoard(page, 'STU');
  await page.locator('.sections-pane .row', { hasText: 'New Section 1' }).click();
  await page.locator('.pages-pane .row', { hasText: 'Practice log' }).click();
  await addTodoLine(page, 'Tune the cello', 60, 40);

  // The View tab's toggle opens the board beside the page, Inbox first.
  await page.getByRole('tab', { name: 'View' }).click();
  await page.locator('.ribbon').getByRole('button', { name: 'Board beside page' }).click();
  const beside = page.locator('.board-beside');
  await expect(beside).toBeVisible();
  await expect(page.getByLabel('Page title', { exact: true })).toHaveValue('Practice log');
  // Until its divider is dragged, the board takes half of what the nav panes leave, so the page keeps the other half.
  const split = (await page.locator('.page-and-board').boundingBox())!;
  expect(Math.abs((await beside.boundingBox())!.width - split.width / 2)).toBeLessThan(2);
  await expect(beside.locator('.board > *').first()).toHaveClass(/inbox-dock/);
  await expect(inboxLine(page, 'Tune the cello')).toBeVisible();

  // Dragging the line onto a status turns it into a card, and the line on the page into its card link.
  await dragTo(page, inboxLine(page, 'Tune the cello'), status(page, 'Backlog').locator('.status-cards'), { x: 100, y: 10 });
  await expect(status(page, 'Backlog').locator('.card-front', { hasText: 'Tune the cello' })).toBeVisible();
  await expect(page.locator('.page-beside-board span[data-card-link]')).toContainText('STU-1');
  await expect(page.locator('.page-beside-board span[data-card-link]')).toContainText('Backlog');

  // A card opened from the pane becomes the page shown, with the board still beside it.
  await card(page, 'Tune the cello').click();
  await expect(page.getByLabel('Page title', { exact: true })).toHaveValue('Tune the cello');
  await expect(page.locator('.card-strip .card-ref')).toHaveText('STU-1');
  await expect(card(page, 'Tune the cello')).toHaveClass(/is-open/);
  await expect(beside).toBeVisible();

  // The divider sets the pane's width; the width and the open pane survive a reload.
  const before = (await beside.boundingBox())!.width;
  const divider = page.locator('.page-and-board > .pane-divider');
  const box = (await divider.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 200);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 120, box.y + 200, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => Math.round((await beside.boundingBox())!.width)).toBe(Math.round(before - 120));
  await page.reload();
  await expect(page.locator('.sync-status[data-state="synced"]')).toBeVisible();
  await expect(beside).toBeVisible();
  expect(Math.round((await beside.boundingBox())!.width)).toBe(Math.round(before - 120));

  // The strip's Board toggle closes it, and that is kept too.
  await page.locator('.card-strip').getByRole('button', { name: 'Board' }).click();
  await expect(beside).toHaveCount(0);
  await page.reload();
  await expect(page.locator('.sync-status[data-state="synced"]')).toBeVisible();
  await expect(page.getByLabel('Page title', { exact: true })).toHaveValue('Tune the cello');
  await expect(beside).toHaveCount(0);
});
