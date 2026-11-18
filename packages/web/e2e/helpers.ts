/** Steps several tests share: first run with the token, making a notebook, typing into a page, and a notebook's board. */
import { expect, type Locator, type Page } from '@playwright/test';
import { TOKEN } from './server.js';

export const SHOTS = process.env.LOOSELEAF_SHOTS ?? '';

export async function firstRun(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await expect(page.getByText('Enter the access token for this server.')).toBeVisible();
  await page.getByLabel('Access token').fill(TOKEN);
  await page.getByRole('button', { name: 'Start syncing' }).click();
  await expect(page.locator('.sync-status[data-state="synced"]')).toBeVisible();
}

/** Makes a notebook (which comes with a section and an empty page) and names the page. */
export async function newNotebook(page: Page, name: string, pageTitle: string): Promise<void> {
  const button = page.getByRole('button', { name: 'New notebook' });
  if (await button.isVisible()) await button.click();
  else {
    await page.locator('.notebook-switcher').click();
    await page.getByRole('button', { name: 'New notebook' }).click();
  }
  await page.getByLabel('Name').fill(name);
  await page.getByRole('button', { name: 'Create notebook' }).click();
  await expect(page.locator('.notebook-name')).toHaveText(name);
  await expect(page.getByLabel('Page title')).toHaveValue('');
  await page.getByLabel('Page title').fill(pageTitle);
  await expect(page.locator('.pages-pane .row.is-selected')).toHaveText(pageTitle);
}

/** Clicks empty canvas at an offset from its top-left and waits for the new container's editor. */
export async function newTextContainer(page: Page, x: number, y: number) {
  const canvas = page.getByTestId('canvas');
  await canvas.click({ position: { x, y } });
  const editor = page.locator('.container .ProseMirror-focused');
  await expect(editor).toBeVisible();
  return editor;
}

export const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

/** Adds a board to the selected notebook from the notebook menu and waits for its statuses. */
export async function addBoard(page: Page, key: string): Promise<void> {
  await page.locator('.notebook-switcher').click();
  await page.getByRole('button', { name: 'Add a board' }).click();
  await expect(page.getByLabel('Key', { exact: true })).toHaveValue(key);
  await page.getByRole('button', { name: 'Add board' }).click();
  await expect(page.locator('.board-row')).toHaveAttribute('aria-selected', 'true');
  await expect(status(page, 'Backlog')).toBeVisible();
}

/** A status column by its name. */
export function status(page: Page, name: string) {
  return page.locator('section.status-column', { has: page.locator('.status-name', { hasText: new RegExp(`^${name}$`) }) });
}

/** A card front by its title. */
export function card(page: Page, title: string) {
  return page.locator('.card-front', { hasText: title });
}

/** Adds cards to a status through its composer, one Enter each, and closes the composer. */
export async function addCards(page: Page, statusName: string, titles: string[]): Promise<void> {
  const column = status(page, statusName);
  await column.getByRole('button', { name: 'Add a card' }).click();
  const field = column.getByLabel('Card title');
  for (const title of titles) {
    await field.fill(title);
    await field.press('Enter');
    await expect(card(page, title)).toBeVisible();
  }
  await field.press('Escape');
}

/** Types a To Do line into a new text container at an offset on the open page's canvas. */
export async function addTodoLine(page: Page, text: string, x: number, y: number) {
  const editor = await newTextContainer(page, x, y);
  await page.keyboard.type(text);
  await page.keyboard.press(`${mod}+1`);
  await expect(editor.locator('[data-tag="todo"]', { hasText: text })).toBeVisible();
}

/** A real pointer drag from the middle of one element to a point inside another, `at` from its top-left. */
export async function dragTo(page: Page, from: Locator, to: Locator, at: { x: number; y: number }): Promise<void> {
  const start = await from.boundingBox();
  const end = await to.boundingBox();
  if (!start || !end) throw new Error('Drag source or target not laid out');
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(start.x + start.width / 2 + 20, start.y + start.height / 2, { steps: 5 });
  await page.mouse.move(end.x + at.x, end.y + at.y, { steps: 15 });
  await page.mouse.move(end.x + at.x, end.y + at.y + 2, { steps: 2 });
  await page.mouse.up();
  // dnd-kit swallows clicks for 50 ms after a drop.
  await page.waitForTimeout(100);
}

/** An Inbox line by its text. */
export function inboxLine(page: Page, text: string) {
  return page.locator('.inbox-line', { hasText: text });
}
