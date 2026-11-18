import { describe, expect, it } from 'vitest';
import {
  appendToPage,
  boardDocId,
  createPage,
  deleteComment,
  deleteContainer,
  deleteStroke,
  removeLink,
  extractPageText,
  getNode,
  listTodoLines,
  markdownToBody,
  newId,
  notebookDocId,
  pageDocId,
  readBoard,
  readPage,
  setTodoLineChecked,
  type Card,
} from '@looseleaf/model';
import { checkImport } from '../src/corkboard-import-check.js';
import { ImportDocs, planImport } from '../src/corkboard-import.js';
import { listCorkboardBoards, readCorkboardBoard } from '../src/corkboard-folder.js';
import { DataFolderReader } from '../src/data-folder-reader.js';
import { importScenario, NOW } from './corkboard-fixture.js';
import { call, connectedClient, editDoc, mcpClient, waitFor, waitForConvergence } from './harness.js';

function numbers(cards: Card[]): Record<string, number> {
  return Object.fromEntries(cards.map((card) => [card.id, card.number]));
}

describe('a Looseleaf server on an imported board', () => {
  it('serves the board and its cards over MCP, and its start-up repairs change no number or key', async () => {
    const { server, ids, run } = await importScenario();
    await run();
    const reader = new DataFolderReader(server.dataDir);
    const imported = readBoard(await reader.readDoc(boardDocId(ids.notebook)), await reader.readDoc(notebookDocId(ids.notebook)));

    await server.startAgain();
    const client = await mcpClient(server);
    const board = (await call(client, 'get_board', { board: 'SHOP' })).text;
    expect(board).toContain('## Inbox (0 lines)');
    expect(board).toContain('## Later (todo, 2 cards)\n\n- SHOP-1 Build shelf · [Wood] · due 2026-12-01 · checklist 2/4 · 2 comments\n- SHOP-5 Tidy bench · [Wood, Misc]');
    expect(board).toContain('## Doing (doing, 3 cards)\n\n- SHOP-2 Shelf brackets · [Wood]\n- SHOP-3 Shed scope · [Misc]\n- SHOP-6 Paint the shed');
    const card = (await call(client, 'get_card', { card: 'SHOP-1' })).text;
    expect(card).toContain(`- Id: ${ids.shelfNotes}`);
    expect(card).toContain('Existing shelf notes\n\n- [x] Buy pine\n\nTitle before the Corkboard import: Shelf notes\n\nPine, **two** boards.');
    expect(card).toContain('## Checklist (2/4)');
    expect(card).toContain('- Plan — https://example.com/shelf');
    expect(card).toContain('### Sam, 1970-01-01 00:00 UTC (edited)\n\nBought the pine');
    expect(card).toContain('Sam created this card in Later');
    const archived = (await call(client, 'get_card', { card: 'SHOP-4' })).text;
    expect(archived).toContain('- Status: Done (done) — archived');
    await server.stop();

    const after = readBoard(await reader.readDoc(boardDocId(ids.notebook)), await reader.readDoc(notebookDocId(ids.notebook)));
    expect(after.meta.key).toBe('SHOP');
    expect(numbers(after.cards)).toEqual(numbers(imported.cards));
  });

  it('reaches a replica that was offline with the notebook, keeping every edit it made meanwhile', async () => {
    const { server, ids, run } = await importScenario();
    await server.startAgain();
    const replica = await connectedClient(server);
    const shelf = pageDocId(ids.shelfNotes);
    await waitForConvergence(server, [replica.store], [notebookDocId(ids.notebook), shelf]);
    replica.control.blocked = true;
    replica.control.cutAll();
    await waitFor(() => replica.client.status.state === 'offline', 'the replica to be offline');

    const { body } = await markdownToBody('Written while offline', { stamp: { now: () => NOW, newId } });
    await editDoc(replica.client, shelf, (doc) => appendToPage(doc, body));
    let offlinePage = '';
    await editDoc(replica.client, notebookDocId(ids.notebook), (doc) => {
      offlinePage = createPage(doc, { section: ids.bench, title: 'Offline page' });
    });
    await server.stop();
    expect((await run()).ok).toBe(true);
    await server.startAgain();
    replica.control.blocked = false;

    const docs = await waitForConvergence(server, [replica.store], [notebookDocId(ids.notebook), shelf, boardDocId(ids.notebook)]);
    const notebook = docs.get(notebookDocId(ids.notebook))!;
    expect(getNode(notebook, ids.shelfNotes)?.name).toBe('Build shelf');
    expect(getNode(notebook, offlinePage)?.name).toBe('Offline page');
    const text = extractPageText(docs.get(shelf)!);
    expect(text).toContain('Written while offline');
    expect(text).toContain('Title before the Corkboard import: Shelf notes');
    expect(text).toContain('Existing shelf notes');
    const board = readBoard(docs.get(boardDocId(ids.notebook))!, notebook);
    expect(board.meta.key).toBe('SHOP');
    expect(board.cards.map((card) => card.number).sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("keeps the imported text when a replica deletes the adopted page's last text container while apart", async () => {
    const { server, ids, run } = await importScenario();
    await server.startAgain();
    const replica = await connectedClient(server);
    const shelf = pageDocId(ids.shelfNotes);
    await waitForConvergence(server, [replica.store], [shelf]);
    replica.control.blocked = true;
    replica.control.cutAll();
    await waitFor(() => replica.client.status.state === 'offline', 'the replica to be offline');
    await editDoc(replica.client, shelf, (doc) => {
      const texts = readPage(doc).containers.filter((container) => container.kind === 'text');
      deleteContainer(doc, texts.at(-1)!.id);
    });
    await server.stop();
    expect((await run()).ok).toBe(true);
    await server.startAgain();
    replica.control.blocked = false;

    const page = (await waitForConvergence(server, [replica.store], [shelf])).get(shelf)!;
    const text = extractPageText(page);
    expect(text).not.toContain('Existing shelf notes');
    expect(text).toContain('Title before the Corkboard import: Shelf notes');
    expect(text).toContain('Pine, two boards.');
    expect(listTodoLines(page).map((line) => [line.text, line.checked])).toEqual([
      ['Measure the wall', false],
      ['Cut', true],
      ['Sand', false],
    ]);
  });
});

describe('the import check', () => {
  it('names each difference between the board and what was made of it', async () => {
    const { server, corkboardDir, ids } = await importScenario();
    const source = new DataFolderReader(corkboardDir);
    const board = await readCorkboardBoard(source, (await listCorkboardBoards(source))[0]!);
    const docs = new ImportDocs(new DataFolderReader(server.dataDir));
    await planImport({ source: board, docs, notebookId: ids.notebook, ties: new Map(), pictureSizes: new Map(), now: NOW });
    const input = { source: board, notebookId: ids.notebook, ties: new Map(), before: (docId: string) => docs.before(docId), missingBlobs: new Set<string>() };
    const result = { doc: (docId: string) => docs.get(docId), blobHeld: async () => true };
    expect((await checkImport({ ...input, result })).mismatches).toEqual([]);

    const shelf = await docs.get(pageDocId(ids.shelfNotes));
    deleteStroke(shelf, readPage(shelf).strokes[0]!.id);
    setTodoLineChecked(shelf, listTodoLines(shelf).find((line) => line.text === 'Cut')!.id!, false);
    deleteComment(await docs.get(boardDocId(ids.notebook)), ids.shelfNotes, 'cm-1');
    removeLink(await docs.get(boardDocId(ids.notebook)), ids.shelfNotes, 'ln-2');
    const stray = createPage(await docs.get(notebookDocId(ids.notebook)), { section: ids.bench, title: 'Stray' });

    const { mismatches, totals } = await checkImport({ ...input, result: { ...result, blobHeld: async () => false } });
    expect(mismatches).toEqual([
      "SHOP-1: the link to https://example.com/shelf is gone, and it does not name the card's page " + ids.shelfNotes,
      'SHOP-1: 2 links are gone; one, the link naming its page, should be',
      expect.stringMatching(/^SHOP-1: comments is .*, not .*Bought the pine/),
      'SHOP-1: the checklist item "Cut" (ticked) is not a To Do line on the page in its place',
      'SHOP-1: the blob of "sketch.png" (3adf9c5f7dd2af40a6081435fc6cb3cca94b7eb3f8073761b4cfdb302c1eae56) is not in Looseleaf\'s blob store',
      'SHOP-1: the blob of "cut list.pdf" (4cd092645d06bab88a6a2a5490daa511251e7e6725dd108c44d4d541fa7620eb) is not in Looseleaf\'s blob store',
      "SHOP-1: the page's strokes changed",
      'SHOP-7: the blob of "lost.txt" (' + board.cards.find((card) => card.number === 7)!.attachments[0]!.blob + ") is not in Looseleaf's blob store",
      `The notebook has a new node ${stray} that is no card's page`,
      'The result has 1 comments, not 2',
      'The result has 7 links, not 8',
      'The result has 2 checklist items, not 3',
    ]);
    expect(totals.comments).toEqual({ source: 2, result: 1 });
    expect(totals.checklistItems).toEqual({ source: 3, result: 2 });

    const imported = readPage(shelf).containers.filter((container) => container.kind === 'text').at(-1)!;
    deleteContainer(shelf, imported.id);
    expect((await checkImport({ ...input, result })).mismatches).toContain('SHOP-1: the page does not hold its old title "Shelf notes"');
  });
});
