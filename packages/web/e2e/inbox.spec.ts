/** The board's Inbox: lines tagged on a loose page, the "Inbox" pill and line menu, ticking, "Keep it as a line", dragging a line into a status, and the card link a line becomes. */
import { expect, test } from '@playwright/test';
import { addBoard, addCards, addTodoLine, card, dragTo, firstRun, inboxLine, newNotebook, status } from './helpers.js';
import { TestServer } from './server.js';

let server: TestServer;
test.beforeAll(async () => {
  server = await TestServer.create();
});
test.afterAll(async () => {
  await server.dispose();
});

// Wide enough that the Inbox and four statuses show beside an open page.
test.use({ viewport: { width: 2400, height: 1000 } });

test('lines from a loose page reach the Inbox, become cards from the page and by drag, and their card links follow the card', async ({ page }) => {
  await firstRun(page, server.url);
  await newNotebook(page, 'Garden', 'Spring jobs');
  // Tagged before the board existed, so it never reaches the Inbox.
  await addTodoLine(page, 'Rake the leaves', 60, 40);
  await addBoard(page, 'GAR');
  await expect(page.locator('.inbox-empty')).toHaveText('New To Do lines from this notebook’s pages land here.');

  await page.locator('.sections-pane .row', { hasText: 'New Section 1' }).click();
  await page.locator('.pages-pane .row', { hasText: 'Spring jobs' }).click();
  await addTodoLine(page, 'Prune the roses', 60, 120);
  await addTodoLine(page, 'Mend the fence', 60, 200);
  await addTodoLine(page, 'Order seeds', 60, 280);
  await addTodoLine(page, 'Sow carrots', 60, 360);
  const line = (text: string) => page.locator('.rich-text [data-tag="todo"]', { hasText: text });
  await expect(line('Prune the roses').locator('.inbox-pill')).toBeVisible();
  await expect(line('Rake the leaves').locator('.inbox-pill')).toHaveCount(0);

  // The pill opens the line's menu; "Make it a card in" turns the line into a card link.
  await line('Order seeds').locator('.inbox-pill').click();
  await expect(page.locator('.context-menu .menu-heading')).toHaveText('Make it a card in');
  await page.getByRole('menuitem', { name: 'In progress' }).click();
  const link = page.locator('.rich-text span[data-card-link]');
  await expect(link).toContainText('GAR-1');
  await expect(link).toContainText('Order seeds');
  await expect(link).toContainText('In progress');
  await expect(line('Order seeds')).toHaveCount(0);

  // The Inbox lists the rest newest first, each with its page; the line tagged before the board is not there.
  await page.locator('.board-row').click();
  const inbox = page.getByTestId('inbox');
  await expect(inbox.locator('.inbox-text')).toHaveText(['Sow carrots', 'Mend the fence', 'Prune the roses']);
  await expect(inboxLine(page, 'Sow carrots').locator('.inbox-source')).toHaveText('Spring jobs');
  await expect(status(page, 'In progress').locator('.card-front', { hasText: 'Order seeds' })).toBeVisible();

  // A line's page opens beside the board, and its card link follows the card's status as it moves.
  await inboxLine(page, 'Prune the roses').locator('.inbox-source').click();
  const pane = page.locator('.card-pane');
  await expect(pane.getByLabel('Page title')).toHaveValue('Spring jobs');
  const paneLink = pane.locator('span[data-card-link]');
  await expect(paneLink).toContainText('In progress');
  await dragTo(page, card(page, 'Order seeds'), status(page, 'This week').locator('.status-cards'), { x: 100, y: 10 });
  await expect(status(page, 'This week').locator('.card-front', { hasText: 'Order seeds' })).toBeVisible();
  await expect(paneLink).toContainText('This week');

  // Clicking the link opens the card's page; a retitle there shows on the link.
  await paneLink.click();
  await expect(pane.getByLabel('Page title')).toHaveValue('Order seeds');
  await expect(pane.locator('.card-strip .card-ref')).toHaveText('GAR-1');
  await pane.getByLabel('Page title').fill('Order seeds and bulbs');
  await inboxLine(page, 'Prune the roses').locator('.inbox-source').click();
  await expect(pane.getByLabel('Page title')).toHaveValue('Spring jobs');
  await expect(paneLink).toContainText('Order seeds and bulbs');
  // Escape closes the page beside the board.
  await page.keyboard.press('Escape');
  await expect(pane).toHaveCount(0);

  // Ticking from the Inbox, and "Keep it as a line" from its menu.
  await inboxLine(page, 'Mend the fence').getByRole('checkbox').click();
  await expect(inboxLine(page, 'Mend the fence')).toHaveCount(0);
  await inboxLine(page, 'Prune the roses').getByRole('button', { name: 'Line actions' }).click();
  await page.getByRole('menuitem', { name: 'Keep it as a line' }).click();
  await expect(inboxLine(page, 'Prune the roses')).toHaveCount(0);

  // A line dragged between two cards becomes a card there.
  await addCards(page, 'Backlog', ['Weed the beds', 'Water the pots']);
  // Let go over the lower part of the card, whatever its height while its page text is still being read.
  const water = (await card(page, 'Water the pots').boundingBox())!;
  await dragTo(page, inboxLine(page, 'Sow carrots'), card(page, 'Water the pots'), { x: 60, y: water.height - 8 });
  await expect(status(page, 'Backlog').locator('.card-title')).toHaveText(['Water the pots', 'Sow carrots', 'Weed the beds']);
  await expect(page.locator('.inbox-empty')).toBeVisible();
  // Cards never drop into the Inbox.
  await dragTo(page, card(page, 'Weed the beds'), page.getByTestId('inbox'), { x: 60, y: 30 });
  await expect(page.locator('.inbox-line')).toHaveCount(0);
  await expect(card(page, 'Weed the beds')).toBeVisible();

  // On the page: the ticked line, the kept line without its pill, and the dragged line as a card link.
  await page.locator('.sections-pane .row', { hasText: 'New Section 1' }).click();
  await page.locator('.pages-pane .row', { hasText: 'Spring jobs' }).click();
  await expect(line('Mend the fence')).toHaveAttribute('data-checked', 'true');
  await expect(line('Prune the roses')).toBeVisible();
  await expect(line('Prune the roses').locator('.inbox-pill')).toHaveCount(0);
  await expect(page.locator('.rich-text span[data-card-link]', { hasText: 'Sow carrots' })).toContainText('Backlog');
  await expect(page.locator('.rich-text span[data-card-link]', { hasText: 'Order seeds and bulbs' })).toContainText('This week');
});
