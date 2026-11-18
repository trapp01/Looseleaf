import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import {
  appendTodoLine,
  archiveCard,
  boardDocId,
  cardsInStatus,
  createBoard,
  createPage,
  createSection,
  getNode,
  listTodoLines,
  notebookDocId,
  pageDocId,
  putOnBoard,
  readBoard,
  type TodoLineStamp,
} from '@looseleaf/model';
import type { Services } from '../src/app/services.js';
import { Store } from '../src/app/store.js';
import { describeCardLink } from '../src/board/card-link-view.js';
import { lineDropPlace, type Columns } from '../src/board/drag-model.js';
import { edgeScrollStep } from '../src/board/edge-scroll.js';
import { matchingCardIds } from '../src/board/filter.js';
import { keepLine, makeCard, tickLine } from '../src/board/line-actions.js';
import type { CurrentBoard } from '../src/board/live-board.js';
import { followPageInbox } from '../src/board/page-inbox.js';
import { PageSession } from '../src/canvas/page-session.js';
import { replicaDocAccess } from '../src/board/doc-access.js';
import { SearchIndex } from '../src/search/search-index.js';
import { TodoLineIndex } from '../src/search/todo-line-index.js';

const BOARD_MADE = 1_000_000;
let ids = 0;
const stamp = (now: number): TodoLineStamp => ({ now: () => now, newId: () => `line-${++ids}` });

/** A notebook with a board made at BOARD_MADE, a loose page "Spring jobs" and its page doc, all held by a fake replica. */
function garden() {
  const notebookId = 'garden';
  const notebook = new Y.Doc();
  const section = createSection(notebook, { name: 'Beds', parent: null });
  const board = new Y.Doc();
  createBoard(board, { notebookId, name: 'Garden', takenKeys: [], now: BOARD_MADE });
  const pageId = createPage(notebook, { section, title: 'Spring jobs', modifiedAt: 1 });
  const page = new Y.Doc();
  const docs = new Map<string, Y.Doc>([
    [notebookDocId(notebookId), notebook],
    [boardDocId(notebookId), board],
    [pageDocId(pageId), page],
  ]);
  const client = {
    openDoc: async (id: string) => {
      if (!docs.has(id)) docs.set(id, new Y.Doc());
      return docs.get(id)!;
    },
    releaseDoc: () => undefined,
  };
  const current = (): CurrentBoard => ({ notebookId, doc: board, notebookDoc: notebook, board: readBoard(board, notebook), flashing: new Set() });
  const toasts = { show: vi.fn() };
  const services = {
    access: replicaDocAccess(client),
    todoLines: new TodoLineIndex(),
    actor: new Store('Robin'),
    toasts,
  } as unknown as Services;
  return { notebookId, notebook, section, board, pageId, page, current, services, toasts };
}

describe('Inbox line actions', () => {
  it('ticks a line and keeps a line on its page, and the line index follows at once', async () => {
    const g = garden();
    const prune = appendTodoLine(g.page, 'Prune the roses', stamp(BOARD_MADE + 1));
    const mend = appendTodoLine(g.page, 'Mend the fence', stamp(BOARD_MADE + 2));
    const ref = (lineId: string) => ({ notebookId: g.notebookId, pageId: g.pageId, lineId });
    await tickLine(g.services, ref(mend), true);
    await keepLine(g.services, ref(prune));
    const lines = listTodoLines(g.page);
    expect(lines.find((line) => line.id === mend)?.checked).toBe(true);
    expect(lines.find((line) => line.id === prune)?.inbox).toBe(false);
    expect(g.services.todoLines.linesFor(g.pageId)).toEqual(lines);
    // The page is touched, so other devices' search passes read it again.
    expect(getNode(g.notebook, g.pageId)?.modifiedAt).toBeGreaterThan(1);
  });

  it('makes a card from a line at the place it was dropped, and the line becomes its card link', async () => {
    const g = garden();
    const backlog = g.current().board.statuses[0]!;
    for (const title of ['Weed the beds', 'Water the pots']) putOnBoard(g.board, createPage(g.notebook, { section: g.section, title }), { statusId: backlog.id, by: 'test' });
    const sow = appendTodoLine(g.page, 'Sow carrots', stamp(BOARD_MADE + 1));
    await makeCard(g.services, { notebookId: g.notebookId, pageId: g.pageId, lineId: sow }, backlog.id, 1);
    const snapshot = readBoard(g.board, g.notebook);
    expect(cardsInStatus(snapshot, backlog.id).map((card) => card.title)).toEqual(['Water the pots', 'Sow carrots', 'Weed the beds']);
    expect(snapshot.cards.find((card) => card.id === sow)?.activity.map((entry) => entry.type)).toEqual(['created']);
    expect(listTodoLines(g.page)).toEqual([]);
    expect(g.services.todoLines.linesFor(g.pageId)).toEqual([]);
  });

  it('leaves nothing for the page’s undo after a line becomes a card', async () => {
    const g = garden();
    const sow = appendTodoLine(g.page, 'Sow carrots', stamp(BOARD_MADE + 1));
    const session = new PageSession(g.notebookId, g.pageId, g.page, g.notebook);
    await makeCard(g.services, { notebookId: g.notebookId, pageId: g.pageId, lineId: sow }, g.current().board.statuses[0]!.id);
    await tickLine(g.services, { notebookId: g.notebookId, pageId: g.pageId, lineId: sow }, true);
    expect(session.undo.undoStack).toHaveLength(0);
    session.undo.undo();
    expect(listTodoLines(g.page)).toEqual([]);
    expect(readBoard(g.board, g.notebook).cards.map((card) => card.id)).toEqual([sow]);
    session.destroy();
  });

  it('says so when a line cannot become a card', async () => {
    const g = garden();
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await makeCard(g.services, { notebookId: g.notebookId, pageId: g.pageId, lineId: 'gone' }, g.current().board.statuses[0]!.id);
    expect(g.toasts.show).toHaveBeenCalledWith('Couldn’t make the card. Try again.');
    quiet.mockRestore();
  });
});

describe('followPageInbox', () => {
  it('names the page’s lines in the Inbox, from the line index, and none once the page is a card', () => {
    const g = garden();
    appendTodoLine(g.page, 'Rake the leaves', stamp(BOARD_MADE - 1));
    const prune = appendTodoLine(g.page, 'Prune the roses', stamp(BOARD_MADE + 1));
    const index = new TodoLineIndex();
    const indexPage = () => index.set(g.pageId, g.notebookId, listTodoLines(g.page));
    indexPage();
    const boards = { current: new Store<CurrentBoard | null>(g.current()) };
    const session = { notebookId: g.notebookId, pageId: g.pageId, inbox: new Store<ReadonlySet<string>>(new Set()) };
    const stop = followPageInbox(session, boards, index);
    expect([...session.inbox.get()]).toEqual([prune]);

    const mend = appendTodoLine(g.page, 'Mend the fence', stamp(BOARD_MADE + 2));
    indexPage();
    expect([...session.inbox.get()].sort()).toEqual([prune, mend].sort());

    putOnBoard(g.board, g.pageId, { by: 'test' });
    boards.current.set(g.current());
    expect(session.inbox.get().size).toBe(0);
    archiveCard(g.board, g.pageId, 'test');
    boards.current.set(g.current());
    expect(session.inbox.get().size).toBe(2);
    boards.current.set(null);
    expect(session.inbox.get().size).toBe(0);
    stop();
  });
});

describe('the search pass', () => {
  it('reads the open board’s card pages before the rest', async () => {
    const order: string[] = [];
    const pages = ['a', 'b', 'card-1', 'c', 'card-2'].map((pageId) => ({ pageId, notebookId: 'n', sectionId: 's', title: pageId, modifiedAt: 1 }));
    const search = new SearchIndex(
      {
        listPages: () => pages,
        readPage: async (pageId) => (order.push(pageId), { text: pageId, lines: [] }),
        firstPages: () => new Set(['card-1', 'card-2']),
      },
      async () => undefined,
    );
    expect(search.hasRead('card-1')).toBe(false);
    await search.refresh();
    expect(order).toEqual(['card-1', 'card-2', 'a', 'b', 'c']);
    expect(search.hasRead('card-1')).toBe(true);
    // After the first pass a page not read yet is a new one, and new pages start empty.
    expect(search.hasRead('made-since')).toBe(true);
  });
});

describe('describeCardLink', () => {
  it('shows the card’s ref, title and status, “archived” for an archived card, and the title alone for a page that is not a card', () => {
    const g = garden();
    const id = createPage(g.notebook, { section: g.section, title: 'Order seeds' });
    const inProgress = g.current().board.statuses.find((status) => status.kind === 'doing')!;
    putOnBoard(g.board, id, { statusId: inProgress.id, by: 'test' });
    expect(describeCardLink(g.current(), [], id)).toEqual({ title: 'Order seeds', ref: 'GAR-1', status: inProgress.name, kind: 'doing', archived: false });
    archiveCard(g.board, id, 'test');
    expect(describeCardLink(g.current(), [], id)).toMatchObject({ ref: 'GAR-1', status: null, archived: true });
    expect(describeCardLink(g.current(), [], g.pageId)).toEqual({ title: 'Spring jobs', ref: null, status: null, kind: null, archived: false });
    expect(describeCardLink(null, [g.notebook], id)).toMatchObject({ title: 'Order seeds', ref: null });
    expect(describeCardLink(null, [], 'nowhere').title).toBe('Linked card');
  });
});

describe('dropping an Inbox line', () => {
  const columns: Columns = { todo: ['a', 'b'], doing: [] };

  it('lands before or after the card under it, or at the bottom of a status', () => {
    expect(lineDropPlace(columns, { kind: 'card', cardId: 'b', below: false })).toEqual({ statusId: 'todo', index: 1 });
    expect(lineDropPlace(columns, { kind: 'card', cardId: 'b', below: true })).toEqual({ statusId: 'todo', index: 2 });
    expect(lineDropPlace(columns, { kind: 'status', statusId: 'doing' })).toEqual({ statusId: 'doing', index: 0 });
    expect(lineDropPlace(columns, { kind: 'status', statusId: 'inbox' })).toBeNull();
    expect(lineDropPlace(columns, { kind: 'card', cardId: 'gone', below: false })).toBeNull();
  });
});

describe('board search', () => {
  it('keeps cards with every word in the title or page text, together with the label filter', () => {
    const g = garden();
    const plane = createPage(g.notebook, { section: g.section, title: 'Sharpen the plane' });
    const bench = createPage(g.notebook, { section: g.section, title: 'Oil the bench' });
    putOnBoard(g.board, plane, { by: 'test' });
    putOnBoard(g.board, bench, { by: 'test' });
    const snapshot = readBoard(g.board, g.notebook);
    const text = (pageId: string) => (pageId === bench ? 'Linseed oil, two coats' : '');
    expect(matchingCardIds(snapshot, [], 'plane', text)).toEqual(new Set([plane]));
    expect(matchingCardIds(snapshot, [], 'linseed coats', text)).toEqual(new Set([bench]));
    expect(matchingCardIds(snapshot, ['no-such-label'], 'linseed', text)).toEqual(new Set());
    expect(matchingCardIds(snapshot, [], '  ', text)).toBeNull();
  });
});

describe('edge scrolling while dragging', () => {
  it('scrolls left past the pinned Inbox and right at the far edge, faster nearer the edge, and not in between', () => {
    // The Inbox's right side is the left edge at 300; the board ends at 1400.
    expect(edgeScrollStep(800, 300, 1400)).toBe(0);
    expect(edgeScrollStep(1395, 300, 1400)).toBeGreaterThan(edgeScrollStep(1340, 300, 1400));
    expect(edgeScrollStep(1340, 300, 1400)).toBeGreaterThan(0);
    expect(edgeScrollStep(310, 300, 1400)).toBeLessThan(0);
    // Over the Inbox itself it scrolls at full speed.
    expect(edgeScrollStep(100, 300, 1400)).toBe(edgeScrollStep(300 - 500, 300, 1400));
  });
});
