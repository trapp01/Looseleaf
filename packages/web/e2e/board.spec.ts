/** A notebook's board: adding one, cards from the composer and from loose pages, a card's page beside the board, and the card strip and Activity panel. */
import { expect, test, type Browser } from '@playwright/test';
import { addBoard, addCards, card, firstRun, mod, newNotebook, status } from './helpers.js';
import { TestServer } from './server.js';

let server: TestServer;
test.beforeAll(async () => {
  server = await TestServer.create();
});
test.afterAll(async () => {
  await server.dispose();
});

test('a board, cards from the composer, a card’s page typed on beside the board, a move, a drag and the full page', async ({ page }) => {
  await firstRun(page, server.url);
  await newNotebook(page, 'Allotment', 'Plot plan');
  await addBoard(page, 'ALL');
  await expect(page.locator('.pages-pane')).toHaveCount(0);

  await addCards(page, 'Backlog', ['Sow peas', 'Turn the compost', 'Net the kale']);
  await expect(status(page, 'Backlog').locator('.card-front')).toHaveCount(3);
  // The composer adds at the top, so the last added is first.
  await expect(status(page, 'Backlog').locator('.card-front').first()).toContainText('Net the kale');
  await expect(card(page, 'Sow peas').locator('.card-ref')).toHaveText('ALL-1');
  await expect(page.locator('.sections-pane .row', { hasText: 'Unfiled' })).toBeVisible();

  // The card's page opens beside the board: the real canvas, with the strip under the title and the ribbon acting on it.
  await card(page, 'Sow peas').click();
  const pane = page.locator('.card-pane');
  await expect(pane.getByLabel('Page title')).toHaveValue('Sow peas');
  await expect(pane.locator('.card-strip .card-ref')).toHaveText('ALL-1');
  await expect(page.getByTestId('board')).toBeVisible();
  await pane.getByTestId('canvas').click({ position: { x: 60, y: 40 } });
  const editor = pane.locator('.container .ProseMirror-focused');
  await expect(editor).toBeVisible();
  await page.keyboard.type('Soak the seeds overnight');
  await page.keyboard.press('Enter');
  await page.locator('.ribbon').getByRole('option', { name: 'To Do' }).click();
  await page.keyboard.type('Buy pea sticks');
  await expect(editor.locator('[data-tag="todo"]')).toHaveText('Buy pea sticks');
  await page.locator('.ribbon').getByRole('button', { name: 'Bold' }).click();
  await page.keyboard.type(' now');
  await expect(editor.locator('strong')).toHaveText('now');
  // The card front follows the page once typing pauses: its first lines and its checklist.
  await expect(card(page, 'Sow peas').locator('.card-excerpt')).toContainText('Soak the seeds overnight');
  await expect(card(page, 'Sow peas').locator('.badge', { hasText: '0/1' })).toBeVisible();
  await expect(pane.locator('.strip-count')).toHaveText('0/1');

  // The status picker moves the card.
  await pane.getByLabel('Status').selectOption({ label: 'In progress' });
  await expect(status(page, 'In progress').locator('.card-front', { hasText: 'Sow peas' })).toBeVisible();
  await pane.getByRole('button', { name: 'Close card' }).click();
  await expect(pane).toHaveCount(0);

  // Renaming a status in place.
  await status(page, 'Blocked').locator('.status-name-button').click();
  await page.getByLabel('Status name').fill('Waiting');
  await page.getByLabel('Status name').press('Enter');
  await expect(status(page, 'Waiting')).toBeVisible();
  // Renaming scrolled the board to the status; the drag below starts from the left again.
  await page.getByTestId('board').evaluate((board) => board.scrollTo({ left: 0 }));

  // A real drag: Backlog's "Turn the compost" onto This week's empty space.
  const dragged = card(page, 'Turn the compost');
  const from = await dragged.boundingBox();
  const target = await status(page, 'This week').locator('.status-cards').boundingBox();
  if (!from || !target) throw new Error('Card or status not laid out');
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 20, from.y + from.height / 2, { steps: 5 });
  await page.mouse.move(target.x + target.width / 2, target.y + 10, { steps: 15 });
  await page.mouse.move(target.x + target.width / 2, target.y + 12, { steps: 2 });
  await page.mouse.up();
  await expect(status(page, 'This week').locator('.card-front', { hasText: 'Turn the compost' })).toBeVisible();
  await expect(status(page, 'Backlog').locator('.card-front')).toHaveCount(1);
  // dnd-kit swallows clicks for 50 ms after a drop, so a press that ends a drag does not also open the card.
  await page.waitForTimeout(100);

  // "Open full page" switches to the notebook view at the page; the pages pane shows its status.
  await card(page, 'Sow peas').click();
  await pane.getByRole('button', { name: 'Open full page' }).click();
  await expect(page.getByTestId('board')).toHaveCount(0);
  await expect(page.getByLabel('Page title')).toHaveValue('Sow peas');
  await expect(page.locator('.pages-pane .row.is-selected .row-status')).toHaveText('In progress');
  await expect(page.locator('.card-strip .card-ref')).toHaveText('ALL-1');

  // Everything is still there after a reload.
  await page.reload();
  await expect(page.locator('.sync-status[data-state="synced"]')).toBeVisible();
  await page.locator('.board-row').click();
  await expect(status(page, 'In progress').locator('.card-front', { hasText: 'Sow peas' })).toBeVisible();
  await expect(status(page, 'This week').locator('.card-front', { hasText: 'Turn the compost' })).toBeVisible();
  await expect(card(page, 'Sow peas').locator('.badge', { hasText: '0/1' })).toBeVisible();
});

test('a loose page put on the board, a comment, a link, a label and its filter, archive with undo and restore', async ({ page }) => {
  await firstRun(page, server.url);
  await newNotebook(page, 'Kitchen', 'Fix the tap');
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByLabel('Your name').fill('Robin');
  await page.getByRole('button', { name: 'Save name' }).click();
  await page.keyboard.press('Escape');
  await addBoard(page, 'KIT');

  // Back in the notebook view, the loose page goes on the board from the ribbon.
  await page.locator('.sections-pane .row', { hasText: 'New Section 1' }).click();
  await page.locator('.pages-pane .row', { hasText: 'Fix the tap' }).click();
  await expect(page.locator('.card-strip')).toHaveCount(0);
  await page.locator('.ribbon').getByRole('button', { name: 'Put on board' }).click();
  await expect(page.locator('.card-strip .card-ref')).toHaveText('KIT-1');
  await expect(page.locator('.ribbon').getByRole('button', { name: 'Put on board' })).toBeDisabled();
  await expect(page.locator('.pages-pane .row.is-selected .row-status')).toHaveText('Backlog');

  // The Activity panel starts closed on a card with no comments or links, and opens from the strip.
  await expect(page.locator('.activity-panel')).toHaveCount(0);
  await page.locator('.card-strip').getByRole('button', { name: 'Activity' }).click();
  const activity = page.locator('.activity-panel');
  await expect(activity.locator('.timeline-activity')).toContainText('Robin added this card to Backlog');
  await activity.getByLabel('Write a comment').fill('The washer is **worn**.');
  await activity.getByLabel('Write a comment').press(`${mod}+Enter`);
  await expect(activity.locator('.timeline-comment strong')).toHaveText('worn');
  await expect(activity.locator('.timeline-comment .actor')).toHaveText('Robin');
  await activity.getByRole('button', { name: 'Add a link' }).click();
  await activity.getByLabel('Address').fill('example.com/taps');
  await activity.getByRole('button', { name: 'Add link' }).click();
  await expect(activity.locator('.link-host')).toHaveText('example.com');

  // A label made from the strip.
  await page.locator('.card-strip').getByRole('button', { name: 'Add labels' }).click();
  await page.getByLabel('New label').fill('Plumbing');
  await page.getByRole('button', { name: 'Create label' }).click();
  await expect(page.locator('.card-strip .label-chip')).toHaveText('Plumbing');
  await page.keyboard.press('Escape');

  // On the board: the card carries the label and the comment count; the label filter narrows the board.
  await page.locator('.board-row').click();
  await addCards(page, 'Backlog', ['Descale the kettle']);
  await expect(card(page, 'Fix the tap').locator('.label-chip')).toHaveText('Plumbing');
  await expect(card(page, 'Fix the tap').locator('.badge', { hasText: '1' }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Filter' }).click();
  await page.getByRole('dialog', { name: 'Filter by label' }).getByRole('checkbox').check();
  await page.keyboard.press('Escape');
  await expect(page.locator('.card-front')).toHaveCount(1);
  await expect(page.locator('.filter-count')).toHaveText('1 of 2 cards');
  await expect(page.locator('.drag-hint')).toBeVisible();
  await page.getByRole('button', { name: 'Clear filter' }).click();
  await expect(page.locator('.card-front')).toHaveCount(2);

  // Archive from the card front's menu offers Undo; archived again from the strip, it comes back from Archived items.
  await card(page, 'Descale the kettle').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Archive' }).click();
  await expect(card(page, 'Descale the kettle')).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(card(page, 'Descale the kettle')).toBeVisible();
  await card(page, 'Descale the kettle').click();
  await page.locator('.card-pane').getByRole('button', { name: 'Card actions' }).click();
  await page.getByRole('menuitem', { name: 'Archive' }).click();
  await expect(card(page, 'Descale the kettle')).toHaveCount(0);
  await expect(page.locator('.card-pane')).toHaveCount(0);
  await page.getByRole('button', { name: 'Archived items' }).click();
  const archive = page.getByRole('dialog', { name: 'Archived items' });
  await expect(archive.locator('.archive-row')).toContainText('Descale the kettle');
  await archive.getByRole('button', { name: 'Restore' }).click();
  await page.keyboard.press('Escape');
  await expect(card(page, 'Descale the kettle')).toBeVisible();
});

async function device(browser: Browser) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await firstRun(page, server.url);
  return { context, page };
}

test('a card changed on another device moves and flashes on this board', async ({ browser }) => {
  const one = await device(browser);
  await newNotebook(one.page, 'Workshop', 'Sharpen the chisels');
  await addBoard(one.page, 'WOR');
  await addCards(one.page, 'Backlog', ['Oil the bench']);

  const two = await device(browser);
  await two.page.locator('.notebook-switcher').click();
  await two.page.getByRole('menuitemradio', { name: 'Workshop' }).click();
  await two.page.locator('.board-row').click();
  await card(two.page, 'Oil the bench').click();
  await two.page.locator('.card-pane').getByLabel('Status').selectOption({ label: 'Done' });

  const moved = status(one.page, 'Done').locator('.card-front', { hasText: 'Oil the bench' });
  await expect(moved).toBeVisible();
  await expect(moved).toHaveClass(/is-flashing/);
  await expect(moved.locator('.card-done-mark')).toBeVisible();
  await one.context.close();
  await two.context.close();
});
