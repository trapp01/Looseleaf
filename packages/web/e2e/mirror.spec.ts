/**
 * The desktop app's mirror, with the shell bridge faked inside the page: the
 * fake keeps the mirror's files in memory, so the test reads what the shell
 * would have written. A second, plain browser replica makes the remote edits.
 */
import { expect, test, type Browser, type Page } from '@playwright/test';
import { firstRun, newNotebook, newTextContainer } from './helpers.js';
import { TestServer, TOKEN } from './server.js';

let server: TestServer;
test.beforeEach(async () => {
  server = await TestServer.create();
});
test.afterEach(async () => {
  await server.dispose();
});

const FOLDER = '/home/ann/Notes mirror';

/** Runs in the page before the app. Only the mirror calls do anything. */
function installFakeShell(folderName: string): void {
  const files = new Map<string, string>();
  let manifest: Uint8Array | null = null;
  let folder: string | null = null;
  const decoder = new TextDecoder();
  (window as unknown as { mirrorFiles: Map<string, string> }).mirrorFiles = files;
  (window as unknown as { looseleafShell: unknown }).looseleafShell = {
    kind: 'desktop',
    platform: 'linux',
    saveFile: async () => false,
    savePdf: async () => false,
    findOneNoteBackups: async () => null,
    pickFolder: async () => null,
    listOneNoteFiles: async () => [],
    readOneNoteFile: async () => new Uint8Array(),
    onMenuCommand: () => () => undefined,
    chooseMirrorFolder: async () => {
      folder = folderName;
      return { status: 'chosen', folder };
    },
    mirrorFolder: async () => folder,
    stopMirroring: async () => {
      folder = null;
    },
    readMirrorManifest: async () => manifest,
    applyMirrorBatch: async (batch: {
      removals: string[];
      assets: unknown[];
      pages: Array<{ path: string; bytes: Uint8Array }>;
      manifest: Uint8Array;
    }) => {
      if (folder === null) throw new Error('No mirror folder is chosen');
      for (const path of batch.removals) files.delete(path);
      for (const page of batch.pages) files.set(page.path, decoder.decode(page.bytes));
      manifest = batch.manifest;
      return { written: batch.pages.length + batch.assets.length, removed: batch.removals.length, refused: [] };
    },
  };
}

async function desktopReplica(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(installFakeShell, FOLDER);
  const page = await context.newPage();
  await page.goto(server.url);
  await page.getByRole('button', { name: /Connect to a server/ }).click();
  await page.getByLabel('Server address').fill(server.url);
  await page.getByLabel('Access token').fill(TOKEN);
  await page.getByRole('button', { name: 'Connect' }).click();
  await expect(page.locator('.sync-status[data-state="synced"]')).toBeVisible();
  return page;
}

const mirrorFile = (page: Page, path: string) =>
  page.evaluate((p) => (window as unknown as { mirrorFiles: Map<string, string> }).mirrorFiles.get(p) ?? null, path);

test('the desktop mirror follows local edits and edits synced from another replica', async ({ browser }) => {
  const a = await desktopReplica(browser);
  const bContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const b = await bContext.newPage();
  await firstRun(b, server.url);
  await newNotebook(b, 'Shared', 'From B');
  await newTextContainer(b, 60, 40);
  await b.keyboard.type('Typed on the other replica.');
  await expect(b.locator('.sync-status[data-state="synced"]')).toBeVisible();

  // A plain browser has no Mirror folder row.
  await b.getByRole('button', { name: 'Settings' }).click();
  await expect(b.getByRole('heading', { name: 'Sync' })).toBeVisible();
  await expect(b.getByRole('heading', { name: 'Mirror folder' })).toHaveCount(0);
  await b.keyboard.press('Escape');

  await expect(a.locator('.notebook-name')).toHaveText('Shared');
  await a.getByRole('button', { name: 'Settings' }).click();
  await expect(a.getByRole('heading', { name: 'Mirror folder' })).toBeVisible();
  await a.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(a.getByText(FOLDER)).toBeVisible();
  await expect(a.getByText('Up to date')).toBeVisible();
  await expect(a.getByRole('button', { name: 'Stop mirroring' })).toBeVisible();
  await a.keyboard.press('Escape');
  await expect.poll(() => mirrorFile(a, 'Shared/New Section 1/From B.md')).toContain('Typed on the other replica.');

  // A local edit on A.
  await a.locator('.pages-pane .row', { hasText: 'From B' }).click();
  await a.locator('.container p', { hasText: 'Typed on the other replica.' }).click();
  await a.keyboard.press('End');
  await a.keyboard.type(' Added on A.');
  await expect.poll(() => mirrorFile(a, 'Shared/New Section 1/From B.md'), { timeout: 20_000 }).toContain('Added on A.');

  // A page made on B that A never opens.
  await b.locator('.pages-pane').getByRole('button', { name: 'Add page' }).click();
  await b.getByLabel('Page title').fill('Second from B');
  await newTextContainer(b, 60, 40);
  await b.keyboard.type('Never opened on A.');
  await expect.poll(() => mirrorFile(a, 'Shared/New Section 1/Second from B.md'), { timeout: 30_000 }).toContain('Never opened on A.');

  await a.context().close();
  await bContext.close();
});
