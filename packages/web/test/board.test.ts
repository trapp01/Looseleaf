import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import {
  addCard,
  addComment,
  archiveCard,
  boardDocId,
  cardsInStatus,
  createBoard,
  createLabel,
  createNotebook,
  createPage,
  createSection,
  labelCard,
  LIBRARY_DOC_ID,
  moveCard,
  notebookDocId,
  putOnBoard,
  readBoard,
  renameNode,
  setCardDue,
} from '@looseleaf/model';
import { replicaDocAccess } from '../src/board/doc-access.js';
import { dragOver, dropPlace, placeCard, samePlace, type Columns } from '../src/board/drag-model.js';
import { dueState, todayDay } from '../src/board/due.js';
import { liveLabelFilter, matchingCardIds } from '../src/board/filter.js';
import { FLASH_MS, liveCard, LiveBoard } from '../src/board/live-board.js';
import { changedCardIds } from '../src/board/live-changes.js';
import { cardTimeline, describeActivity } from '../src/board/timeline.js';
import { SelectionStore } from '../src/app/selection.js';
import { NotebookDocs } from '../src/nav/notebook-docs.js';

/** A notebook with one section and a board on it, as plain docs. */
function notebookWithBoard(notebookId = 'garden') {
  const notebook = new Y.Doc();
  const section = createSection(notebook, { name: 'Beds', parent: null });
  const board = new Y.Doc();
  createBoard(board, { notebookId, name: 'Garden', takenKeys: [] });
  const page = (title: string) => createPage(notebook, { section, title });
  return { notebook, board, section, page };
}

/** An in-memory stand-in for the sync client: docs by id, with open and release counted. */
function fakeClient(docs = new Map<string, Y.Doc>()) {
  const open = new Map<string, number>();
  return {
    docs,
    open,
    openDoc: async (id: string) => {
      open.set(id, (open.get(id) ?? 0) + 1);
      if (!docs.has(id)) docs.set(id, new Y.Doc());
      return docs.get(id)!;
    },
    releaseDoc: (id: string) => {
      const count = open.get(id) ?? 0;
      if (count === 0) throw new Error(`released ${id} more times than opened`);
      open.set(id, count - 1);
    },
  };
}

const columns: Columns = { todo: ['a', 'b', 'c'], doing: ['d'], done: [] };

describe('drag model', () => {
  it('reorders inside a status the way a sortable list does', () => {
    expect(dragOver(columns, 'a', { kind: 'card', cardId: 'c', below: false }).todo).toEqual(['b', 'c', 'a']);
    expect(dragOver(columns, 'c', { kind: 'card', cardId: 'a', below: true }).todo).toEqual(['c', 'a', 'b']);
  });

  it('crosses to another status before or after the card under the pointer, or to the bottom of an empty one', () => {
    expect(dragOver(columns, 'b', { kind: 'card', cardId: 'd', below: false })).toEqual({ todo: ['a', 'c'], doing: ['b', 'd'], done: [] });
    expect(dragOver(columns, 'b', { kind: 'card', cardId: 'd', below: true }).doing).toEqual(['d', 'b']);
    expect(dragOver(columns, 'a', { kind: 'status', statusId: 'done' }).done).toEqual(['a']);
    expect(dragOver(columns, 'a', { kind: 'status', statusId: 'todo' })).toBe(columns);
    expect(placeCard(columns, 'b', 'todo', 1)).toBe(columns);
  });

  it('lands where the model puts it', () => {
    const { notebook, board, page } = notebookWithBoard();
    const [backlog, thisWeek] = readBoard(board, notebook).statuses;
    const ids = ['Sow peas', 'Turn compost', 'Net the kale'].map((title) => page(title));
    for (const id of [...ids].reverse()) putOnBoard(board, id, { statusId: backlog!.id, by: 'test' });
    const other = page('Order bulbs');
    putOnBoard(board, other, { statusId: thisWeek!.id, by: 'test' });
    const start: Columns = { [backlog!.id]: ids, [thisWeek!.id]: [other] };
    const after = dragOver(start, ids[0]!, { kind: 'card', cardId: other, below: true });
    const place = dropPlace(after, ids[0]!)!;
    expect(samePlace(start, after, ids[0]!)).toBe(false);
    moveCard(board, ids[0]!, { statusId: place.statusId, place: place.index }, 'test');
    const snapshot = readBoard(board, notebook);
    expect(cardsInStatus(snapshot, thisWeek!.id).map((card) => card.id)).toEqual([other, ids[0]]);
  });
});

describe('label filter', () => {
  it('keeps cards carrying any chosen label and drops labels that were deleted', () => {
    const { notebook, board, page } = notebookWithBoard();
    const herbs = createLabel(board, { name: 'Herbs' });
    const fruit = createLabel(board, { name: 'Fruit' });
    const basil = page('Pinch out basil');
    const plums = page('Thin the plums');
    putOnBoard(board, basil, { labelIds: [herbs.id], by: 'test' });
    putOnBoard(board, plums, { labelIds: [fruit.id], by: 'test' });
    putOnBoard(board, page('Sweep the path'), { by: 'test' });
    const snapshot = readBoard(board, notebook);
    expect(matchingCardIds(snapshot, [])).toBeNull();
    expect(matchingCardIds(snapshot, [herbs.id])).toEqual(new Set([basil]));
    expect(matchingCardIds(snapshot, [herbs.id, fruit.id])).toEqual(new Set([basil, plums]));
    expect(liveLabelFilter(snapshot, [herbs.id, 'gone'])).toEqual([herbs.id]);
    const kept = [herbs.id];
    expect(liveLabelFilter(snapshot, kept)).toBe(kept);
  });
});

describe('due days and the timeline', () => {
  it('is overdue only when past and not in a done status', () => {
    expect(dueState(null, '2026-11-16', 'todo')).toBe('none');
    expect(dueState('2026-11-15', '2026-11-16', 'doing')).toBe('overdue');
    expect(dueState('2026-11-15', '2026-11-16', 'done')).toBe('finished');
    expect(dueState('2026-11-16', '2026-11-16', 'todo')).toBe('today');
    expect(dueState('2026-12-01', '2026-11-16', null)).toBe('upcoming');
    expect(todayDay(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
  });

  it('merges comments and activity oldest first, so the newest sits by the comment box', () => {
    const { notebook, board, page } = notebookWithBoard();
    const statuses = readBoard(board, notebook).statuses;
    let now = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => (now += 1_000));
    const id = page('Mulch the roses');
    putOnBoard(board, id, { by: 'Ana', now: Date.now() });
    addComment(board, id, 'Bark or straw?', 'Ana');
    moveCard(board, id, { statusId: statuses[2]!.id }, 'agent');
    archiveCard(board, id, 'Ana');
    vi.restoreAllMocks();
    const entries = cardTimeline(readBoard(board, notebook).cards[0]!);
    expect(entries.map((entry) => (entry.kind === 'comment' ? `comment:${entry.comment.body}` : entry.activity.type))).toEqual([
      'created',
      'comment:Bark or straw?',
      'moved',
      'archived',
    ]);
    const moved = entries[2]!;
    expect(moved.kind === 'activity' && describeActivity(moved.activity)).toBe('moved this card from Backlog to In progress');
  });
});

describe('changedCardIds', () => {
  it('names new and changed cards, a retitled page included', () => {
    const { notebook, board, page } = notebookWithBoard();
    const a = page('Fix the gate');
    const b = page('Paint the shed');
    putOnBoard(board, a, { by: 'test' });
    putOnBoard(board, b, { by: 'test' });
    const before = readBoard(board, notebook);
    renameNode(notebook, a, 'Fix the side gate');
    const c = page('Clear the gutters');
    putOnBoard(board, c, { by: 'agent' });
    const changed = changedCardIds(before, readBoard(board, notebook));
    expect(changed.sort()).toEqual([a, c].sort());
  });
});

describe('replicaDocAccess', () => {
  it('runs the model’s cross-doc changes on the replica’s docs and releases every doc it opened', async () => {
    const { notebook, board } = notebookWithBoard('garden');
    const client = fakeClient(new Map([
      [notebookDocId('garden'), notebook],
      [boardDocId('garden'), board],
    ]));
    const access = replicaDocAccess(client);
    const tie = createLabel(board, { name: 'Veg' });
    const { pageId, number } = await addCard(access, { notebookId: 'garden', title: 'Plant garlic', by: 'Robin' });
    expect(number).toBe(1);
    const snapshot = readBoard(board, notebook);
    expect(liveCard(snapshot, pageId)?.title).toBe('Plant garlic');
    expect(snapshot.cards[0]!.sectionId).toBe('garden-unfiled');
    await labelCard(access, { notebookId: 'garden', pageId, labelId: tie.id, on: true });
    expect(readBoard(board, notebook).cards[0]!.labelIds).toEqual([tie.id]);
    expect([...client.open.values()].every((count) => count === 0)).toBe(true);
  });
});

describe('LiveBoard', () => {
  afterEach(() => vi.useRealTimers());

  async function setUp() {
    const library = new Y.Doc();
    const notebookId = createNotebook(library, { name: 'Garden', color: 'green' });
    const other = createNotebook(library, { name: 'Kitchen', color: 'blue' });
    const { notebook, board, page } = notebookWithBoard(notebookId);
    const client = fakeClient(new Map([
      [LIBRARY_DOC_ID, library],
      [notebookDocId(notebookId), notebook],
      [boardDocId(notebookId), board],
    ]));
    const notebooks = new NotebookDocs(client as never, library);
    await notebooks.load(notebookId);
    await notebooks.load(other);
    const selection = new SelectionStore();
    selection.selectNotebook(notebookId);
    const live = new LiveBoard(client, selection, notebooks);
    await vi.waitFor(() => expect(live.current.get()).not.toBeNull());
    return { live, client, notebookId, other, notebook, board, page, selection };
  }

  it('follows the selected notebook and has no board for a notebook without one', async () => {
    const { live, client, notebookId, other, selection } = await setUp();
    expect(live.current.get()!.board.meta.key).toBe('GAR');
    selection.selectNotebook(other);
    expect(live.current.get()).toBeNull();
    await vi.waitFor(() => expect(client.open.get(boardDocId(other))).toBe(1));
    expect(live.current.get()).toBeNull();
    expect(client.open.get(boardDocId(notebookId))).toBe(0);
  });

  it('re-reads after a change to the board or the notebook and flashes only cards changed from elsewhere', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { live, notebook, board, page } = await setUp();
    const mine = page('Edge the lawn');
    putOnBoard(board, mine, { by: 'me' });
    expect(live.current.get()!.board.cards.map((card) => card.title)).toEqual(['Edge the lawn']);
    expect(live.current.get()!.flashing.size).toBe(0);

    const elsewhere = new Y.Doc();
    Y.applyUpdate(elsewhere, Y.encodeStateAsUpdate(board));
    setCardDue(elsewhere, mine, '2026-12-01');
    Y.applyUpdate(board, Y.encodeStateAsUpdate(elsewhere), 'server');
    expect(live.current.get()!.flashing.has(mine)).toBe(true);
    vi.advanceTimersByTime(FLASH_MS);
    expect(live.current.get()!.flashing.size).toBe(0);

    renameNode(notebook, mine, 'Edge the front lawn');
    expect(live.current.get()!.board.cards[0]!.title).toBe('Edge the front lawn');
  });
});
