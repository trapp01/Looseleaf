/**
 * The README's screenshots, written to docs/screenshots from an invented
 * notebook. Skipped unless LOOSELEAF_README_SHOTS is set:
 *
 *   LOOSELEAF_README_SHOTS=1 pnpm --filter @looseleaf/web e2e readme-shots
 */
import { expect, test, type Browser, type Page } from '@playwright/test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importTree, type ImportedBlock, type ImportedNotebook, type ImportedPage, type ImportedParagraph } from '@looseleaf/model';
import { firstRun } from './helpers.js';
import { seed } from './seed.js';
import { TestServer } from './server.js';

test.skip(!process.env.LOOSELEAF_README_SHOTS, 'set LOOSELEAF_README_SHOTS to retake the README screenshots');

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../docs/screenshots');
const CREATED = Date.UTC(2026, 2, 14, 17, 5);

const text = (value: string, extra: Partial<ImportedParagraph> = {}): ImportedParagraph => ({
  type: 'paragraph',
  runs: [{ text: value }],
  ...extra,
});
const todo = (value: string, checked = false) => text(value, { tag: 'todo', checked });
const cell = (value: string, bold = false) => ({ blocks: [{ type: 'paragraph', runs: [{ text: value, bold }] } as ImportedBlock] });
const page = (title: string, level: 0 | 1 | 2 = 0, containers: ImportedPage['containers'] = [], strokes: ImportedPage['strokes'] = []): ImportedPage => ({
  title,
  level,
  createdAt: CREATED,
  modifiedAt: CREATED,
  containers,
  strokes,
  warnings: [],
});

/** A closed loop of points around a box, a little uneven so it reads as drawn by hand. */
function loop(cx: number, cy: number, rx: number, ry: number): number[] {
  const points: number[] = [];
  for (let i = 0; i <= 44; i++) {
    const a = (i / 40) * Math.PI * 2 - 2.2;
    const wobble = 1 + Math.sin(i * 0.9) * 0.025;
    points.push(cx + Math.cos(a) * rx * wobble, cy + Math.sin(a) * ry * wobble);
  }
  return points;
}

const NOTEBOOK: ImportedNotebook = {
  name: 'Homelab',
  color: '#2a9d8f',
  children: [
    {
      kind: 'section',
      name: 'Backups',
      color: '#3b7dd8',
      pages: [
        page(
          'Backup plan',
          0,
          [
            {
              kind: 'text',
              x: 36,
              y: 24,
              width: 430,
              blocks: [
                text('Three copies, two places', { heading: 1 }),
                text('Every device keeps its own copy. The server keeps dated snapshots, and the data folder is plain files, so the nightly job needs nothing special.'),
                text('This weekend', { heading: 2 }),
                todo('Move the data folder onto the mirrored pool', true),
                todo('Point restic at the data folder', true),
                todo('Restore one snapshot onto the spare laptop'),
                todo('Write down where the access token lives'),
                text('A backup nobody has restored is a hope, not a backup.', { tag: 'important' }),
              ],
            },
            {
              kind: 'text',
              x: 500,
              y: 34,
              width: 360,
              blocks: [
                text('Where things live', { heading: 2 }),
                {
                  type: 'table',
                  columnWidths: [115, 115, 115],
                  rows: [
                    [cell('What', true), cell('Where', true), cell('Kept for', true)],
                    [cell('Live notes'), cell('Every device'), cell('Always')],
                    [cell('Snapshots'), cell('Server'), cell('14 days')],
                    [cell('Off-site copy'), cell('Cloud bucket'), cell('1 year')],
                  ],
                },
              ],
            },
            {
              kind: 'text',
              x: 520,
              y: 250,
              width: 320,
              blocks: [text('Does the off-site copy need its own encryption key?', { tag: 'question' })],
            },
            {
              kind: 'text',
              x: 36,
              y: 372,
              width: 430,
              blocks: [
                text('Restore drill', { heading: 2 }),
                {
                  type: 'list',
                  ordered: true,
                  items: [
                    { blocks: [text('Stop the server.')] },
                    { blocks: [text('Copy a dated snapshot over the data folder.')] },
                    { blocks: [text('Start the server. Each device fills in whatever the snapshot is missing.')] },
                  ],
                },
              ],
            },
          ],
          [
            { tool: 'pen', color: '#d1495b', width: 3, points: loop(680, 273, 178, 36) },
            { tool: 'highlighter', color: '#ffe066', width: 18, points: [68, 231, 190, 232, 320, 231, 448, 232] },
          ],
        ),
        page('Restore drill, March', 1, [
          {
            kind: 'text',
            x: 16,
            y: 20,
            width: 320,
            blocks: [
              text('Spare laptop, snapshot of the 12th', { heading: 2 }),
              todo('Server stopped', true),
              todo('Snapshot copied over the data folder', true),
              todo('Server started, token unchanged', true),
              todo('Phone caught up by itself', true),
              todo('Time the whole thing next round'),
              text('Twelve minutes, most of it copying pictures.', { tag: 'remember' }),
            ],
          },
        ]),
        page('Off-site options', 1),
        page('What to keep, and how long'),
        page('Hardware wish list'),
      ],
    },
    { kind: 'section', name: 'Network', color: '#2a9d8f', pages: [page('Address plan'), page('Tailnet devices')] },
    { kind: 'section', name: 'Services', color: '#f0a202', pages: [page('What runs where'), page('Ports')] },
    {
      kind: 'group',
      name: 'Projects',
      children: [
        { kind: 'section', name: 'Media server', color: '#9c4f96', pages: [page('Library layout')] },
        { kind: 'section', name: 'Home automation', color: '#4f9d4a', pages: [page('Sensors')] },
      ],
    },
    { kind: 'section', name: 'Ideas', color: '#e07a9a', pages: [page('Someday')] },
  ],
};

let server: TestServer;
test.beforeAll(async () => {
  server = await TestServer.create();
  await seed(server.url, async (open) => {
    await importTree(NOTEBOOK, {
      getDoc: open,
      putBlob: () => Promise.reject(new Error('the README notebook has no pictures')),
    });
  });
});
test.afterAll(async () => {
  await server.dispose();
});

async function openBackupPlan(page: Page): Promise<void> {
  await firstRun(page, server.url);
  await expect(page.locator('.container', { hasText: 'Three copies' })).toBeVisible();
  // The first container takes focus on open; a focused container shows its frame.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

async function shotIn(browser: Browser, name: string, options: Parameters<Browser['newContext']>[0], prepare: (page: Page) => Promise<void>) {
  const context = await browser.newContext({ deviceScaleFactor: 2, ...options });
  const page = await context.newPage();
  await prepare(page);
  await page.screenshot({ path: resolve(OUT, `${name}.png`), animations: 'disabled' });
  await context.close();
}

test('README screenshots', async ({ browser }) => {
  const desktop = { viewport: { width: 1440, height: 820 } };
  await shotIn(browser, 'desktop', desktop, openBackupPlan);
  await shotIn(browser, 'desktop-dark', { ...desktop, colorScheme: 'dark' }, openBackupPlan);
  await shotIn(browser, 'phone', { viewport: { width: 390, height: 760 }, hasTouch: true, isMobile: true }, async (page) => {
    await firstRun(page, server.url);
    await page.locator('.sections-pane .row', { hasText: 'Backups' }).click();
    await page.locator('.pages-pane .row', { hasText: 'Restore drill, March' }).click();
    await expect(page.locator('.container', { hasText: 'Spare laptop' })).toBeVisible();
  });
});
