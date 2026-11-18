import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  createBoard,
  createPage,
  createSection,
  readBoard,
  readBoardMeta,
  renumberDuplicateCards,
  writeBoardRecord,
  writeCardRecord,
  type CardRecord,
} from '../src/index.js';

const board = {
  key: 'SHOP',
  createdAt: 1_000,
  statuses: [
    { id: 'st-later', name: 'Later', kind: 'todo' as const, order: 'a0', archivedAt: null },
    { id: 'st-old', name: 'Old', kind: 'done' as const, order: 'a1', archivedAt: 1_500 },
    { id: 'st-now', name: 'Now', kind: 'doing' as const, order: 'Zz', archivedAt: null },
  ],
  labels: [
    { id: 'lb-wood', name: 'Wood', color: 'orange' as const, order: 'a0', section: 'sec-1' },
    { id: 'lb-paint', name: 'Paint', color: 'gray' as const, order: 'a1', section: null },
  ],
};

const record: CardRecord = {
  number: 41,
  statusId: 'st-old',
  order: 'a3V',
  labelIds: ['lb-paint', 'lb-wood'],
  due: '2026-03-04',
  comments: [{ id: 'cm-1', body: 'Sanded **twice**', by: 'Sam', at: 2_000, editedAt: 2_100 }],
  links: [{ id: 'ln-1', target: 'https://example.com/plan', title: 'Plan', at: 2_050 }],
  activity: [
    { type: 'created', at: 1_900, by: 'Sam', status: 'Later' },
    { type: 'moved', at: 1_950, by: 'agent', from: 'Later', to: 'Old' },
    { type: 'archived', at: 2_200, by: 'Sam' },
  ],
  createdAt: 1_900,
  createdBy: 'Sam',
  updatedAt: 2_200,
  archivedAt: 2_200,
};

describe('board records', () => {
  it('writes a board with exactly the key, statuses and labels given', () => {
    const doc = new Y.Doc();
    writeBoardRecord(doc, board);
    expect(readBoardMeta(doc)).toEqual({ key: 'SHOP', createdAt: 1_000, unfiledSection: null });
    const read = readBoard(doc, new Y.Doc());
    expect(read.statuses).toEqual([board.statuses[2], board.statuses[0]]);
    expect(read.archivedStatuses).toEqual([board.statuses[1]]);
    expect(read.labels).toEqual(board.labels);
  });

  it('refuses a doc that holds a board and a key that is not normalized', () => {
    const doc = new Y.Doc();
    createBoard(doc, { notebookId: 'nb', name: 'Shop', takenKeys: [] });
    expect(() => writeBoardRecord(doc, board)).toThrow('already has a board');
    expect(() => writeBoardRecord(new Y.Doc(), { ...board, key: 'shop' })).toThrow('is not a board key');
  });

  it('writes a card field for field, with no activity of its own', () => {
    const notebook = new Y.Doc();
    const section = createSection(notebook, { name: 'Bench', parent: null });
    const page = createPage(notebook, { section, title: 'Shelf' });
    const doc = new Y.Doc();
    writeBoardRecord(doc, board);
    writeCardRecord(doc, page, record);
    const [card] = readBoard(doc, notebook).cards;
    const { labelIds, ...rest } = record;
    expect(card).toEqual({ ...rest, labelIds: expect.any(Array), id: page, title: 'Shelf', sectionId: section });
    expect([...card!.labelIds].sort()).toEqual([...labelIds].sort());
    expect(() => writeCardRecord(doc, page, record)).toThrow('is already a card');
  });

  it('keeps numbers a server would not repair', () => {
    const doc = new Y.Doc();
    writeBoardRecord(doc, board);
    writeCardRecord(doc, 'p1', { ...record, number: 7, createdAt: 5 });
    writeCardRecord(doc, 'p2', { ...record, number: 3, createdAt: 1 });
    expect(renumberDuplicateCards(doc)).toBe(0);
  });

  it('reads the same on a replica that receives the record as an update', () => {
    const doc = new Y.Doc();
    writeBoardRecord(doc, board);
    writeCardRecord(doc, 'p1', record);
    const replica = new Y.Doc();
    Y.applyUpdate(replica, Y.encodeStateAsUpdate(doc));
    expect(readBoard(replica, new Y.Doc())).toEqual(readBoard(doc, new Y.Doc()));
  });
});
