import { appendFile, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  LIBRARY_DOC_ID,
  bodyToText,
  boardDocId,
  createBoard,
  createNotebook,
  getNode,
  listTodoLines,
  notebookDocId,
  pageDocId,
  readBoard,
  readPage,
  unfiledSectionId,
  type Card,
} from '@looseleaf/model';
import { ImportRefusal, parseImportArgs } from '../src/corkboard-import-command.js';
import { IMPORT_MARKER_FILE } from '../src/corkboard-import-marker.js';
import { DataFolderReader } from '../src/data-folder-reader.js';
import { docFolderName } from '../src/disk-store.js';
import { CUT_LIST, fingerprint, importScenario as scenario, LOST_BLOB, NOW, offline, PICTURE, shopBoard, type ScenarioIds } from './corkboard-fixture.js';

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

async function result(dataDir: string, ids: ScenarioIds) {
  const reader = new DataFolderReader(dataDir);
  const notebook = await reader.readDoc(notebookDocId(ids.notebook));
  const board = readBoard(await reader.readDoc(boardDocId(ids.notebook)), notebook);
  const card = (number: number): Card => [...board.cards, ...board.hiddenCards].find((candidate) => candidate.number === number)!;
  const page = (pageId: string) => reader.readDoc(pageDocId(pageId));
  return { reader, notebook, board, card, page };
}

/** Each text container's lines with To Do boxes, then each file or picture as `name (kind)`, in reading order. */
function pageLines(doc: Y.Doc): string[] {
  return readPage(doc).containers.flatMap((container) =>
    container.kind === 'text' ? bodyToText(container.body, { tags: true }).split('\n') : [`${container.name} (${container.kind})`],
  );
}

describe('importing a Corkboard board', () => {
  it('carries every card field over exactly, adopting linked pages and filing new ones', async () => {
    const { server, ids, corkboardDir, run } = await scenario();
    const source = shopBoard(ids);
    const sourceCard = (id: string) => source.cards.find((card) => card.id === id)!;
    const untouched = await fingerprint(corkboardDir);

    const outcome = await run();
    expect(outcome.report.mismatches).toEqual([]);
    expect(outcome.ok).toBe(true);
    expect(await fingerprint(corkboardDir)).toEqual(untouched);

    const { reader, notebook, board, card, page } = await result(server.dataDir, ids);
    expect(board.meta).toEqual({ key: 'SHOP', createdAt: NOW, unfiledSection: unfiledSectionId(ids.notebook) });
    expect([...board.statuses, ...board.archivedStatuses]).toEqual(source.statuses);
    expect(board.labels).toEqual([
      { id: 'lb-wood', name: 'Wood', color: 'orange', order: 'a0', section: ids.bench },
      { id: 'lb-paint', name: 'Paint', color: 'red', order: 'a1', section: null },
      { id: 'lb-misc', name: 'Misc', color: 'gray', order: 'a2', section: ids.ideas },
    ]);
    expect([...board.cards, ...board.hiddenCards].map((found) => found.number).sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(board.hiddenCards).toEqual([]);

    for (const sourceEntry of source.cards) {
      const found = card(sourceEntry.number);
      const fields = {
        number: sourceEntry.number,
        title: sourceEntry.title,
        statusId: sourceEntry.status,
        order: sourceEntry.order,
        due: sourceEntry.due ?? null,
        comments: sourceEntry.comments ?? [],
        activity: sourceEntry.activity ?? [],
        createdAt: sourceEntry.createdAt,
        createdBy: sourceEntry.createdBy,
        updatedAt: sourceEntry.updatedAt,
        archivedAt: sourceEntry.archivedAt ?? null,
      };
      expect(found).toMatchObject(fields);
      expect([...found.labelIds].sort()).toEqual([...(sourceEntry.labels ?? [])].sort());
    }

    // SHOP-1 took its linked page, kept what the page held and recorded the title it replaced.
    const shelf = card(1);
    expect(shelf.id).toBe(ids.shelfNotes);
    expect(shelf.links).toEqual([sourceCard('card-shelf').links![1]]);
    expect(getNode(notebook, ids.shelfNotes)).toMatchObject({ name: 'Build shelf', parent: ids.bench });
    const shelfPage = await page(ids.shelfNotes);
    expect(pageLines(shelfPage)).toEqual([
      'Existing shelf notes',
      '[x] Buy pine',
      'Title before the Corkboard import: Shelf notes',
      'Pine, two boards.',
      '[ ] Measure the wall',
      '[x] Cut',
      '[ ] Sand',
      'sketch.png (image)',
      'cut list.pdf (file)',
    ]);
    expect(listTodoLines(shelfPage).slice(1).map((line) => [line.text, line.taggedAt, line.id !== null])).toEqual([
      ['Measure the wall', NOW, true],
      ['Cut', NOW, true],
      ['Sand', NOW, true],
    ]);
    const texts = readPage(shelfPage).containers.filter((container) => container.kind === 'text');
    expect(texts.map((container) => bodyToText(container.body, { tags: true }))).toEqual([
      'Existing shelf notes\n[x] Buy pine',
      'Title before the Corkboard import: Shelf notes\nPine, two boards.\n[ ] Measure the wall\n[x] Cut\n[ ] Sand',
    ]);
    expect(readPage(shelfPage).strokes).toHaveLength(1);
    expect(readPage(shelfPage).containers.find((container) => container.kind === 'image')).toMatchObject({ width: 640, height: 360, mime: 'image/png', size: PICTURE.length });
    expect(await reader.checkedBlob(sha(PICTURE))).toEqual({ bytes: expect.anything() });
    expect(await reader.checkedBlob(sha(CUT_LIST))).toEqual({ bytes: expect.anything() });

    // SHOP-2 and SHOP-6 both link "Shared plan", so neither takes it: each has a new page and keeps its links,
    // and SHOP-6 does not fall back to "Paint notes", which its next link names.
    const brackets = card(2);
    expect(brackets.id).toBe('card-brackets');
    expect(brackets.links).toEqual(sourceCard('card-brackets').links);
    expect(getNode(notebook, brackets.id)).toMatchObject({ name: 'Shelf brackets', parent: ids.bench, createdAt: 1_290 });
    expect(card(6).id).toBe('card-paint-shed');
    expect(card(6).links).toEqual(sourceCard('card-paint-shed').links);
    expect(getNode(notebook, ids.sharedPlan)).toMatchObject({ name: 'Shared plan' });
    expect(getNode(notebook, ids.paintNotes)).toMatchObject({ name: 'Paint notes' });
    expect(readPage(await page(ids.sharedPlan)).containers).toEqual([]);

    // SHOP-3 took the first link whose page is in the notebook; its description was already on the page.
    const shed = card(3);
    expect(shed.id).toBe(ids.shedScope);
    expect(shed.links.map((link) => link.id).sort()).toEqual(['ln-4', 'ln-6']);
    expect(pageLines(await page(ids.shedScope))).toEqual(['Scope: walls first, then the roof.', 'Walls first, then the roof.']);

    // Untied labels and no labels file in the Unfiled section; label order picks the tie.
    expect(getNode(notebook, card(4).id)?.parent).toBe(unfiledSectionId(ids.notebook));
    expect(card(4).links).toEqual(sourceCard('card-door').links);
    expect(pageLines(await page(card(4).id))).toEqual(['[ ] Prime']);
    expect(getNode(notebook, card(5).id)?.parent).toBe(ids.bench);
    expect(getNode(notebook, card(7).id)?.parent).toBe(unfiledSectionId(ids.notebook));
    expect(card(7).id).toBe('card-idea');
    expect(pageLines(await page(card(7).id))).toEqual(['lost.txt (file)']);

    const { report } = outcome;
    expect(report.cards.map((entry) => `${entry.ref} ${entry.page}`)).toEqual(['SHOP-1 adopted', 'SHOP-5 new', 'SHOP-2 new', 'SHOP-3 adopted', 'SHOP-6 new', 'SHOP-4 new', 'SHOP-7 new']);
    expect(report.sharedPages).toEqual([{ pageId: ids.sharedPlan, title: 'Shared plan', refs: ['SHOP-2', 'SHOP-6'] }]);
    expect(report.titlesReplaced).toEqual([{ ref: 'SHOP-1', pageId: ids.shelfNotes, oldTitle: 'Shelf notes', newTitle: 'Build shelf' }]);
    expect(report.descriptionsAlreadyOnPage).toEqual(['SHOP-3']);
    expect(report.linksNotAdopted.map((link) => `${link.ref} ${link.reason}`)).toEqual([
      'SHOP-2 2 cards link to the page, so it is none of their pages',
      'SHOP-3 the page is in the notebook "Garden"',
      'SHOP-3 an earlier link on the card names the page that became the card',
      'SHOP-6 2 cards link to the page, so it is none of their pages',
      "SHOP-6 the card's first link to a page in the notebook names a page several cards link to, so the card has a new page",
      'SHOP-4 the page or its section is in Deleted notes',
      'SHOP-4 no notebook has the page',
    ]);
    expect(report.blobProblems).toEqual([{ ref: 'SHOP-7', name: 'lost.txt', blob: LOST_BLOB, problem: 'the blob is not in the folder' }]);
    expect(report.totals).toEqual({
      cards: { source: 7, result: 7 },
      comments: { source: 2, result: 2 },
      links: { source: 10, result: 8, adoptedAsPages: 2 },
      checklistItems: { source: 3, result: 3 },
      attachments: { source: 3, result: 3 },
      activityEntries: { source: 6, result: 6 },
    });
    expect(report.statusCounts.map((count) => [count.name, count.source, count.result, count.archivedCardsResult])).toEqual([
      ['Later', 2, 2, 0],
      ['Doing', 3, 3, 0],
      ['Done', 1, 1, 1],
      ['Old', 1, 1, 0],
    ]);
    expect(JSON.parse(await readFile(outcome.reportPath, 'utf8'))).toEqual(report);
    expect(outcome.text).toContain('Checked against the data folder, read again from disk: everything matches.');
    expect(JSON.parse(await readFile(join(server.dataDir, IMPORT_MARKER_FILE), 'utf8'))).toMatchObject({ state: 'finished', boardKey: 'SHOP' });
  });

  it('in a dry run, writes nothing to either folder and reports the same import', async () => {
    const { server, corkboardDir, run } = await scenario();
    const looseleaf = await fingerprint(server.dataDir);
    const corkboard = await fingerprint(corkboardDir);
    const dry = await run({ dryRun: true });
    expect(await fingerprint(server.dataDir)).toEqual(looseleaf);
    expect(await fingerprint(corkboardDir)).toEqual(corkboard);
    expect(dry.ok).toBe(true);
    expect(dry.text).toContain('dry run: nothing was written');
    expect(dry.text).toContain('Checked against the docs in memory: everything matches.');

    const real = await run();
    const comparable = (report: typeof dry.report) => ({ ...report, dryRun: null, checkedFrom: null });
    expect(comparable(dry.report)).toEqual(comparable(real.report));
  });

  it('refuses a second run, and an unfinished one, changing nothing', async () => {
    const { server, run } = await scenario();
    await run();
    const looseleaf = await fingerprint(server.dataDir);
    await expect(run()).rejects.toThrow(/already has a board, with the key SHOP/);
    await writeFile(join(server.dataDir, IMPORT_MARKER_FILE), JSON.stringify({ state: 'started', boardKey: 'SHOP', notebookId: 'x', startedAt: 'then', endedAt: null }));
    const marked = await fingerprint(server.dataDir);
    expect(marked).not.toEqual(looseleaf);
    const refusal = 'started at then and did not finish';
    await expect(run()).rejects.toThrow(refusal);
    await expect(server.startAgain()).rejects.toThrow(refusal);
    await expect(run()).rejects.toThrow(/Restore the copy of the data folder made before it, then run the import again\.$/);
    expect(await fingerprint(server.dataDir)).toEqual(marked);
  });

  it('refuses to run again over a run that stopped part way, even with its marker deleted', async () => {
    const { server, ids, outDir, run } = await scenario();
    // The board doc's log is a link into a folder that does not exist: it reads as absent, but appending to it fails.
    const boardFolder = join(server.dataDir, 'docs', docFolderName(boardDocId(ids.notebook)));
    await mkdir(boardFolder, { recursive: true });
    await symlink(join(outDir, 'no-such-folder', 'log'), join(boardFolder, 'log'));
    await expect(run()).rejects.toThrow(/ENOENT/);
    const reader = new DataFolderReader(server.dataDir);
    expect(getNode(await reader.readDoc(notebookDocId(ids.notebook)), 'card-brackets')).not.toBeNull();
    expect(JSON.parse(await readFile(join(server.dataDir, IMPORT_MARKER_FILE), 'utf8'))).toMatchObject({ state: 'started' });

    await rm(join(server.dataDir, IMPORT_MARKER_FILE));
    await rm(join(boardFolder, 'log'));
    const left = await fingerprint(server.dataDir);
    const refusal = await run().catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ImportRefusal);
    expect((refusal as Error).message).toMatch(/^The data folder already holds pages this import would make \(SHOP-5 as card-tidy, SHOP-2 as card-brackets, .*\)/);
    expect((refusal as Error).message).toMatch(/Restore the copy of the data folder made before that import, then run this one again\.$/);
    await expect(run({ dryRun: true })).rejects.toThrow(ImportRefusal);
    expect(await fingerprint(server.dataDir)).toEqual(left);
  });

  it('refuses, changing nothing, when a tie, the board or the notebook cannot be found', async () => {
    const { server, corkboardDir, run } = await scenario({ Wood: 'Garage' });
    const looseleaf = await fingerprint(server.dataDir);
    const corkboard = await fingerprint(corkboardDir);
    await expect(run()).rejects.toThrow('The notebook has no section "Garage" for the label "Wood". Make the section in Looseleaf first, or fix the ties file.');
    await expect(run({ tiesFile: undefined, board: 'NOPE' })).rejects.toThrow(/Corkboard has no board with the key or name "NOPE"\. Its boards are:\n {2}SHOP {2}"Shop"/);
    await expect(run({ tiesFile: undefined, notebook: 'Attic' })).rejects.toThrow(/No notebook has the id or name "Attic"/);
    await expect(run({ tiesFile: undefined, corkboardDir: server.dataDir + '-nothing' })).rejects.toThrow(/holds no Corkboard workspace/);
    expect(await fingerprint(server.dataDir)).toEqual(looseleaf);
    expect(await fingerprint(corkboardDir)).toEqual(corkboard);
  });

  it('refuses a notebook name two notebooks share, a notebook with a board, and a key another board uses', async () => {
    const { server, ids, corkboardDir, run } = await scenario();
    let twin = '';
    await offline(server.dataDir, async (access) => {
      twin = await access.withDoc(LIBRARY_DOC_ID, (doc) => createNotebook(doc, { name: 'workshop' }));
    });
    await expect(run()).rejects.toThrow(`Several notebooks are called "Workshop"; name one by its id with --notebook:\n  ${ids.notebook}  "Workshop"\n  ${twin}  "workshop"`);

    await offline(server.dataDir, async (access) => {
      await access.withDoc(boardDocId(twin), (doc) => createBoard(doc, { notebookId: twin, name: 'workshop', key: 'TWIN', takenKeys: [] }));
      await access.withDoc(boardDocId(ids.garden), (doc) => createBoard(doc, { notebookId: ids.garden, name: 'Garden', key: 'SHOP', takenKeys: [] }));
    });
    const looseleaf = await fingerprint(server.dataDir);
    const corkboard = await fingerprint(corkboardDir);
    await expect(run({ notebook: twin })).rejects.toThrow('The notebook "workshop" already has a board, with the key TWIN; import into a notebook without one.');
    await expect(run({ notebook: ids.notebook })).rejects.toThrow('The board on the notebook "Garden" already has the key SHOP');
    expect(await fingerprint(server.dataDir)).toEqual(looseleaf);
    expect(await fingerprint(corkboardDir)).toEqual(corkboard);
  });

  it('refuses a Corkboard doc whose log ends in a torn record, without setting it aside', async () => {
    const { server, corkboardDir, run } = await scenario();
    await appendFile(join(corkboardDir, 'docs', 'board%3Aboard-shop', 'log'), new Uint8Array([9, 0, 0, 0, 1, 2]));
    const looseleaf = await fingerprint(server.dataDir);
    const corkboard = await fingerprint(corkboardDir);
    const refusal = await run().catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ImportRefusal);
    expect((refusal as Error).message).toMatch(/ends in 6 bytes of torn or corrupt records\. Start and stop that folder's server once/);
    expect(await fingerprint(server.dataDir)).toEqual(looseleaf);
    expect(await fingerprint(corkboardDir)).toEqual(corkboard);
  });

  it('reads its options from the arguments and LOOSELEAF_DATA', () => {
    expect(parseImportArgs(['--corkboard', 'cb', '--notebook', 'Workshop', '--dry-run'], { LOOSELEAF_DATA: '/srv/data' })).toMatchObject({
      dataDir: '/srv/data',
      notebook: 'Workshop',
      dryRun: true,
      board: undefined,
    });
    expect(() => parseImportArgs(['--notebook', 'Workshop'], {})).toThrow(/Name the Corkboard data folder with --corkboard/);
    expect(() => parseImportArgs(['--corkboard', 'cb', '--notebook', 'W', '--force'], {})).toThrow(ImportRefusal);
  });
});
