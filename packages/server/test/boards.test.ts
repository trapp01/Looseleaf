import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  LIBRARY_DOC_ID,
  addCard,
  appendToPage,
  boardDocId,
  createBoard,
  createNotebook,
  createSection,
  createPage,
  getNode,
  listTodoLines,
  markdownToBody,
  moveCard,
  newId,
  notebookDocId,
  pageDocId,
  promoteTodoLine,
  readBoard,
  readBoardMeta,
  readPage,
  setTodoLineChecked,
  writeCardRecord,
  type DocAccess,
} from '@looseleaf/model';
import type { SyncClient } from '@looseleaf/sync';
import { DiskStore } from '../src/disk-store.js';
import { Hub } from '../src/hub.js';
import { call, connectedClient, editDoc, mcpClient, TestServer, waitFor, waitForConvergence } from './harness.js';

/** A replica's docs as `model`'s cross-doc writers want them. */
function clientAccess(client: SyncClient): DocAccess {
  return {
    async withDoc(docId, change) {
      const doc = await client.openDoc(docId);
      try {
        return doc.transact(() => change(doc));
      } finally {
        client.releaseDoc(docId);
      }
    },
  };
}

type Replica = Awaited<ReturnType<typeof connectedClient>>;

async function goOffline(replica: Replica): Promise<void> {
  replica.control.blocked = true;
  replica.control.cutAll();
  await waitFor(() => replica.client.status.state === 'offline', 'the replica to be offline');
}

function goOnline(replica: Replica): void {
  replica.control.blocked = false;
}

/** A notebook called Workshop with one section, and a board on it made through MCP. */
async function workshop(server: TestServer): Promise<{ notebook: string; section: string; run: (name: string, args?: Record<string, unknown>) => ReturnType<typeof call> }> {
  const hub = server.current.hub;
  let notebook = '';
  let section = '';
  await hub.withDoc(LIBRARY_DOC_ID, (doc) => {
    notebook = createNotebook(doc, { name: 'Workshop' });
  });
  await hub.withDoc(notebookDocId(notebook), (doc) => {
    section = createSection(doc, { name: 'Bench', parent: null });
  });
  const client = await mcpClient(server);
  const run = (name: string, args: Record<string, unknown> = {}) => call(client, name, args);
  await run('create_board', { notebook: 'Workshop', key: 'WRK' });
  return { notebook, section, run };
}

function paragraphs(doc: Y.Doc): string[] {
  return readPage(doc).containers.flatMap((container) =>
    container.kind === 'text' ? (container.body.content ?? []).map((block) => JSON.stringify(block)) : [],
  );
}

describe('an agent and a replica working on one card', () => {
  it('keep both sets of edits made apart, and end byte for byte equal', async () => {
    const server = await TestServer.start({ mirror: false });
    const { notebook, run } = await workshop(server);
    const created = await run('create_card', { title: 'Shared', description: 'base text', checklist: ['First', 'Second'] });
    const pageId = /\(page id: ([\w-]+)\)/.exec(created.text)![1]!;
    const docs = [boardDocId(notebook), pageDocId(pageId), notebookDocId(notebook)];
    const replica = await connectedClient(server);
    await waitForConvergence(server, [replica.store], docs);
    await goOffline(replica);

    const [first, second] = listTodoLines(await server.storedDoc(pageDocId(pageId)));
    await editDoc(replica.client, boardDocId(notebook), (doc) => {
      moveCard(doc, pageId, { statusId: readBoard(doc, doc).statuses[2]!.id }, 'Sam');
    });
    await editDoc(replica.client, pageDocId(pageId), (doc) => {
      setTodoLineChecked(doc, first!.id!, true);
    });
    await run('add_comment', { card: 'WRK-1', body: 'Looked into it.' });
    await run('update_checklist', { card: pageId, check: [second!.id!], add: ['Third'] });
    await run('append_to_page', { page_id: 'WRK-1', markdown: 'Added by the agent.' });
    await run('update_card', { card: 'WRK-1', due: '2030-04-01' });

    goOnline(replica);
    const converged = await waitForConvergence(server, [replica.store], docs);
    const board = readBoard(converged.get(boardDocId(notebook))!, converged.get(notebookDocId(notebook))!);
    const card = board.cards[0]!;
    expect(card.statusId).toBe(board.statuses[2]!.id);
    expect(card.comments.map((comment) => comment.body)).toEqual(['Looked into it.']);
    expect(card.due).toBe('2030-04-01');
    const lines = listTodoLines(converged.get(pageDocId(pageId))!);
    expect(lines.map((line) => [line.text, line.checked])).toEqual([
      ['First', true],
      ['Second', true],
      ['Third', false],
    ]);
    expect(paragraphs(converged.get(pageDocId(pageId))!).join('\n')).toContain('Added by the agent.');
    const text = (await run('get_card', { card: 'WRK-1' })).text;
    expect(text).toContain('## Checklist (2/3)');
    expect(text).toContain('- Status: In progress (doing)');
  });
});

describe('the board repairs', () => {
  it('renumber a card that two replicas numbered alike while apart, and both replicas follow', async () => {
    const server = await TestServer.start({ mirror: false });
    const { notebook } = await workshop(server);
    const a = await connectedClient(server);
    const b = await connectedClient(server);
    await waitForConvergence(server, [a.store, b.store], [boardDocId(notebook), notebookDocId(notebook)]);
    await goOffline(a);
    await goOffline(b);
    await addCard(clientAccess(a.client), { notebookId: notebook, title: 'From A', by: 'A', now: 1000 });
    await addCard(clientAccess(b.client), { notebookId: notebook, title: 'From B', by: 'B', now: 2000 });
    goOnline(a);
    goOnline(b);
    const docs = [boardDocId(notebook), notebookDocId(notebook)];
    await waitFor(async () => {
      const board = readBoard(await server.storedDoc(docs[0]!), await server.storedDoc(docs[1]!));
      return board.cards.length === 2 && new Set(board.cards.map((card) => card.number)).size === 2;
    }, 'two cards with numbers of their own');
    const converged = await waitForConvergence(server, [a.store, b.store], docs);
    const board = readBoard(converged.get(docs[0]!)!, converged.get(docs[1]!)!);
    const numbers = Object.fromEntries(board.cards.map((card) => [card.title, card.number]));
    // The card created first keeps its number.
    expect(numbers).toEqual({ 'From A': 1, 'From B': 2 });
  });

  it('give a board that took another board\'s key while apart a key of its own', async () => {
    const server = await TestServer.start({ mirror: false });
    const hub = server.current.hub;
    const ids = { home: '', house: '' };
    await hub.withDoc(LIBRARY_DOC_ID, (doc) => {
      ids.home = createNotebook(doc, { name: 'Home' });
      ids.house = createNotebook(doc, { name: 'House' });
    });
    const a = await connectedClient(server);
    const b = await connectedClient(server);
    await goOffline(a);
    await goOffline(b);
    await editDoc(a.client, boardDocId(ids.house), (doc) => createBoard(doc, { notebookId: ids.house, name: 'House', key: 'HOME', takenKeys: [], now: 1000 }));
    await editDoc(b.client, boardDocId(ids.home), (doc) => createBoard(doc, { notebookId: ids.home, name: 'Home', key: 'HOME', takenKeys: [], now: 2000 }));
    goOnline(a);
    goOnline(b);
    const docs = [boardDocId(ids.home), boardDocId(ids.house)];
    await waitFor(async () => readBoardMeta(await server.storedDoc(docs[0]!))?.key === 'HOME2', 'the newer board to get HOME2');
    const converged = await waitForConvergence(server, [a.store, b.store], docs);
    expect(readBoardMeta(converged.get(boardDocId(ids.house))!)?.key).toBe('HOME');
    expect(readBoardMeta(converged.get(boardDocId(ids.home))!)?.key).toBe('HOME2');
  });

  it('keep one card link when two replicas turn the same line into a card while apart', async () => {
    const server = await TestServer.start({ mirror: false });
    const { notebook, section } = await workshop(server);
    let source = '';
    await server.current.hub.withDoc(notebookDocId(notebook), (doc) => {
      source = createPage(doc, { section, title: 'Ideas' });
    });
    const { body } = await markdownToBody('- [ ] Build a shelf', { stamp: { now: () => Date.now() + 5, newId } });
    await server.current.hub.withDoc(pageDocId(source), (doc) => appendToPage(doc, body));
    const lineId = listTodoLines(await server.storedDoc(pageDocId(source)))[0]!.id!;
    const a = await connectedClient(server);
    const b = await connectedClient(server);
    const docs = [boardDocId(notebook), notebookDocId(notebook), pageDocId(source)];
    await waitForConvergence(server, [a.store, b.store], docs);
    await goOffline(a);
    await goOffline(b);
    await promoteTodoLine(clientAccess(a.client), { notebookId: notebook, sourcePageId: source, lineId, by: 'A' });
    await promoteTodoLine(clientAccess(b.client), { notebookId: notebook, sourcePageId: source, lineId, by: 'B' });
    goOnline(a);
    goOnline(b);
    // Every replica can hold the same two links for a moment before the server's repair reaches them, so wait for both at once.
    const cardLinks = (doc: Y.Doc) => (JSON.stringify(readPage(doc)).match(/"cardLink"/g) ?? []).length;
    let converged = new Map<string, Y.Doc>();
    await waitFor(async () => {
      converged = await waitForConvergence(server, [a.store, b.store], docs);
      return cardLinks(converged.get(pageDocId(source))!) === 1 && readBoard(converged.get(docs[0]!)!, converged.get(docs[1]!)!).cards.length === 1;
    }, 'convergence with one card and one card link');
    expect((JSON.stringify(readPage(converged.get(pageDocId(source))!)).match(/"cardLink"/g) ?? []).length).toBe(1);
    expect(readBoard(converged.get(docs[0]!)!, converged.get(docs[1]!)!).cards.map((card) => card.id)).toEqual([lineId]);
  });

  it('renumber cards a previous run left with one number, at start', async () => {
    const server = await TestServer.start({ mirror: false });
    const { notebook } = await workshop(server);
    await server.stop();
    // A board doc written with the server stopped, as an import would.
    const store = new DiskStore(server.dataDir);
    await store.init();
    const hub = new Hub(store, 'unused');
    const one = await addCard(hub, { notebookId: notebook, title: 'One', by: 'Import', now: 1000 });
    // A second card with the first one's number, as two replicas apart would make.
    const two = await hub.withDoc(notebookDocId(notebook), (doc) => createPage(doc, { section: getNode(doc, one.pageId)!.parent!, title: 'Two' }));
    await hub.withDoc(boardDocId(notebook), (doc) => {
      const first = readBoard(doc, new Y.Doc()).hiddenCards[0]!;
      writeCardRecord(doc, two, { ...first, number: 1, labelIds: [], comments: [], links: [], activity: [], createdAt: 2000, updatedAt: 2000 });
    });
    await hub.close();
    await store.drain();

    await server.startAgain();
    await waitFor(async () => {
      const board = readBoard(await server.storedDoc(boardDocId(notebook)), await server.storedDoc(notebookDocId(notebook)));
      return board.cards.map((card) => `${card.title} ${card.number}`).sort().join() === 'One 1,Two 2';
    }, 'the start-up repair');
  });
});

describe('the To Do line index', () => {
  it('follows To Do lines a replica types and ticks, for the Inbox and the checklist counts', async () => {
    const server = await TestServer.start({ mirror: false });
    const { notebook, section, run } = await workshop(server);
    const created = await run('create_card', { title: 'Paint', checklist: ['Sand', 'Prime'] });
    const cardPage = /\(page id: ([\w-]+)\)/.exec(created.text)![1]!;
    const replica = await connectedClient(server);
    let loose = '';
    await editDoc(replica.client, notebookDocId(notebook), (doc) => {
      loose = createPage(doc, { section, title: 'Loose notes' });
    });
    const { body } = await markdownToBody('- [ ] Fix the tap', { stamp: { now: () => Date.now() + 5, newId } });
    await editDoc(replica.client, pageDocId(loose), (doc) => appendToPage(doc, body));
    const sand = listTodoLines(await server.storedDoc(pageDocId(cardPage))).find((line) => line.text === 'Sand')!;
    await editDoc(replica.client, pageDocId(cardPage), (doc) => setTodoLineChecked(doc, sand.id!, true));
    await waitForConvergence(server, [replica.store], [pageDocId(cardPage), pageDocId(loose)]);

    const board = (await run('get_board')).text;
    expect(board).toContain('- WRK-1 Paint · checklist 1/2');
    expect(board).toContain('## Inbox (1 line)');
    expect(board).toContain('- Fix the tap · on "Loose notes" · line ');

    // The index is built again at start.
    await server.stop();
    await server.startAgain();
    const client = await mcpClient(server);
    expect((await call(client, 'get_board')).text).toBe(board);
  });

  it('builds over 1,900 pages in the background and costs a set insert per stored change', async () => {
    const server = await TestServer.start({ mirror: false });
    const { notebook, section } = await workshop(server);
    await server.stop();
    const store = new DiskStore(server.dataDir);
    await store.init();
    const hub = new Hub(store, 'unused');
    const pageIds: string[] = [];
    await hub.withDoc(notebookDocId(notebook), (doc) => {
      for (let i = 0; i < 1900; i++) pageIds.push(createPage(doc, { section, title: `Page ${i}` }));
    });
    const { body: plain } = await markdownToBody(`# Notes\n\n${'An invented paragraph of filler about nothing much at all.\n\n'.repeat(12)}`);
    const { body: withLines } = await markdownToBody(`${'Some invented filler text.\n\n'.repeat(6)}- [ ] Invented task one\n- [x] Invented task two\n- [ ] Invented task three`, {
      stamp: { now: () => Date.now() + 5, newId },
    });
    for (const [i, pageId] of pageIds.entries()) await hub.withDoc(pageDocId(pageId), (doc) => appendToPage(doc, i % 10 === 0 ? withLines : plain));
    await hub.close();
    await store.drain();

    const started = performance.now();
    await server.startAgain();
    const startMs = performance.now() - started;
    const boards = server.current.boards;
    await boards.checklists([]);
    const builtMs = performance.now() - started;
    const board = await boards.open((await boards.list())[0]!);
    expect((await boards.inbox((await boards.list())[0]!, board)).length).toBe(190 * 2);

    // A stored change marks the page; the next read re-reads only that page.
    const changed = pageIds[5]!;
    const { body: extra } = await markdownToBody('- [ ] One more', { stamp: { now: () => Date.now() + 5, newId } });
    const editStarted = performance.now();
    await server.current.hub.withDoc(pageDocId(changed), (doc) => appendToPage(doc, extra));
    const storeMs = performance.now() - editStarted;
    const readStarted = performance.now();
    expect((await boards.checklists([changed])).get(changed)?.map((line) => line.text)).toEqual(['One more']);
    const rereadMs = performance.now() - readStarted;
    console.log(
      `To Do line index over 1,900 pages: server start ${startMs.toFixed(0)} ms, index ready ${builtMs.toFixed(0)} ms after start began; ` +
        `one stored page change ${storeMs.toFixed(1)} ms with its link repair, re-reading it ${rereadMs.toFixed(1)} ms`,
    );
    expect(builtMs).toBeLessThan(15_000);
  }, 60_000);
});
