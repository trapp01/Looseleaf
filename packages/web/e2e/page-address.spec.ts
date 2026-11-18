/** A page address opens its page, whichever notebook holds it. */
import { expect, test } from '@playwright/test';
import { createNotebook, createPage, createSection, LIBRARY_DOC_ID, notebookDocId, pageHash } from '@looseleaf/model';
import { firstRun } from './helpers.js';
import { seed } from './seed.js';
import { TestServer } from './server.js';

let server: TestServer;
const pages = { recipes: '', trips: '' };
test.beforeAll(async () => {
  server = await TestServer.create();
  await seed(server.url, async (open) => {
    const library = await open(LIBRARY_DOC_ID);
    const kitchen = await open(notebookDocId(createNotebook(library, { name: 'Kitchen' })));
    pages.recipes = createPage(kitchen, { section: createSection(kitchen, { name: 'Baking', parent: null }), title: 'Bread recipes' });
    const travel = await open(notebookDocId(createNotebook(library, { name: 'Travel' })));
    pages.trips = createPage(travel, { section: createSection(travel, { name: 'Plans', parent: null }), title: 'Trips to plan' });
  });
});
test.afterAll(async () => {
  await server.dispose();
});

test('a page address opens the page in its notebook, as a first load and as a followed link', async ({ page }) => {
  await firstRun(page, server.url);

  await page.goto(`${server.url}/${pageHash(pages.trips)}`);
  await expect(page.getByLabel('Page title')).toHaveValue('Trips to plan');
  await expect(page.locator('.notebook-name')).toHaveText('Travel');
  await expect(page).toHaveURL(`${server.url}/`);

  // The desktop app hands over an address this way: the fragment changes on a page that is already open.
  await page.evaluate((hash) => {
    window.location.hash = hash;
  }, pageHash(pages.recipes));
  await expect(page.getByLabel('Page title')).toHaveValue('Bread recipes');
  await expect(page.locator('.notebook-name')).toHaveText('Kitchen');
  await expect(page).toHaveURL(`${server.url}/`);

  await page.evaluate(() => {
    window.location.hash = '#page=no-such-page';
  });
  await expect(page.getByLabel('Page title')).toHaveValue('Bread recipes');
});
