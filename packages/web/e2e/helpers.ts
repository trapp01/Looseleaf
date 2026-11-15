/** Steps several tests share: first run with the token, making a notebook, typing into a page. */
import { expect, type Page } from '@playwright/test';
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
