import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  addCard,
  addComment,
  clearDeletedComments,
  deleteComment,
  editComment,
  addLink,
  addTextContainer,
  archiveCard,
  archiveStatus,
  createStatus,
  boardDocId,
  createBoard,
  createLabel,
  createSection,
  createPage,
  deleteNode,
  findCard,
  getNode,
  labelCard,
  listTodoLines,
  looseleafTarget,
  moveCard,
  notebookDocId,
  pageDocId,
  promoteTodoLine,
  putOnBoard,
  readBoard,
  readBoardMeta,
  readPage,
  readTree,
  removeDuplicateCardLinks,
  renameNode,
  renumberDuplicateCards,
  setCardDue,
  tagTodoLine,
  textContainerBodies,
  unfiledSectionId,
  updateStatus,
} from '../src/index.js';
import { MemoryReplica, accessTo, forkReplica, replicaBytes, syncReplicas } from './helpers.js';

const NOTEBOOK = 'nb1';

/** A replica with a notebook holding two sections, a board, and a label tied to the Garden section. */
async function setup() {
  const replica = new MemoryReplica();
  const notebook = await replica.getDoc(notebookDocId(NOTEBOOK));
  const garden = createSection(notebook, { name: 'Garden', parent: null });
  const scratch = createSection(notebook, { name: 'Scratch', parent: null });
  const board = await replica.getDoc(boardDocId(NOTEBOOK));
  createBoard(board, { notebookId: NOTEBOOK, name: 'Home', key: 'HOME', takenKeys: [], now: 100 });
  const outdoor = createLabel(board, { name: 'Outdoor', section: garden });
  const urgent = createLabel(board, { name: 'Urgent' });
  return { replica, access: accessTo(replica), garden, scratch, outdoor, urgent };
}

function docs(replica: MemoryReplica) {
  return { notebook: replica.doc(notebookDocId(NOTEBOOK)), board: replica.doc(boardDocId(NOTEBOOK)) };
}

function sectionOf(replica: MemoryReplica, pageId: string): string | null {
  return getNode(docs(replica).notebook, pageId)?.parent ?? null;
}

/** A loose page in Scratch with one To Do line tagged after the board was made. */
async function pageWithLine(replica: MemoryReplica, scratch: string): Promise<string> {
  const source = createPage(docs(replica).notebook, { section: scratch, title: 'Ideas' });
  const page = await replica.getDoc(pageDocId(source));
  addTextContainer(page, {
    x: 0,
    y: 0,
    width: 300,
    body: { type: 'doc', content: [{ type: 'paragraph', attrs: { tag: 'todo', lineId: 'line-a', taggedAt: 200 }, content: [{ type: 'text', text: 'Build a cold frame' }] }] },
  });
  return source;
}

describe('adding a card', () => {
  it('files the page in the section tied to its first label', async () => {
    const { replica, access, garden, outdoor, urgent } = await setup();
    const { pageId, number } = await addCard(access, { notebookId: NOTEBOOK, title: 'Prune the apple tree', labelIds: [urgent.id, outdoor.id], by: 'Sam' });
    expect(number).toBe(1);
    expect(sectionOf(replica, pageId)).toBe(garden);
    expect(findCard(readBoard(docs(replica).board, docs(replica).notebook), pageId)).toMatchObject({ title: 'Prune the apple tree', labelIds: [urgent.id, outdoor.id] });
  });

  it('files the page in the Unfiled section, made when first needed, when no label tie applies', async () => {
    const { replica, access, garden, urgent } = await setup();
    const { notebook } = docs(replica);
    deleteNode(notebook, garden);
    const first = await addCard(access, { notebookId: NOTEBOOK, title: 'One', labelIds: [urgent.id], by: 'Sam' });
    const second = await addCard(access, { notebookId: NOTEBOOK, title: 'Two', by: 'Sam' });
    const unfiled = unfiledSectionId(NOTEBOOK);
    expect([sectionOf(replica, first.pageId), sectionOf(replica, second.pageId)]).toEqual([unfiled, unfiled]);
    expect(readTree(notebook).children.map((child) => child.name)).toEqual(['Scratch', 'Unfiled']);
    expect(readBoardMeta(docs(replica).board)?.unfiledSection).toBe(unfiled);
  });

  it('brings the Unfiled section back from Deleted notes when it is needed again', async () => {
    const { replica, access } = await setup();
    await addCard(access, { notebookId: NOTEBOOK, title: 'One', by: 'Sam' });
    deleteNode(docs(replica).notebook, unfiledSectionId(NOTEBOOK));
    const { pageId } = await addCard(access, { notebookId: NOTEBOOK, title: 'Two', by: 'Sam' });
    expect(readTree(docs(replica).notebook).children.find((child) => child.id === unfiledSectionId(NOTEBOOK))).toBeDefined();
    expect(sectionOf(replica, pageId)).toBe(unfiledSectionId(NOTEBOOK));
  });

  it('refuses a notebook with no board', async () => {
    const replica = new MemoryReplica();
    await expect(addCard(accessTo(replica), { notebookId: 'none', title: 'X', by: 'Sam' })).rejects.toThrow('This notebook has no board');
  });
});

describe('labelling a card', () => {
  it('moves a page out of the Unfiled section once, on its first tied label', async () => {
    const { replica, access, garden, scratch, outdoor, urgent } = await setup();
    const { pageId } = await addCard(access, { notebookId: NOTEBOOK, title: 'Mulch', by: 'Sam' });
    await labelCard(access, { notebookId: NOTEBOOK, pageId, labelId: urgent.id, on: true });
    expect(sectionOf(replica, pageId)).toBe(unfiledSectionId(NOTEBOOK));
    await labelCard(access, { notebookId: NOTEBOOK, pageId, labelId: outdoor.id, on: true });
    expect(sectionOf(replica, pageId)).toBe(garden);
    await labelCard(access, { notebookId: NOTEBOOK, pageId, labelId: outdoor.id, on: false });
    expect(sectionOf(replica, pageId)).toBe(garden);

    const loose = createPage(docs(replica).notebook, { section: scratch, title: 'Elsewhere' });
    await addCard(access, { notebookId: NOTEBOOK, title: 'unused', by: 'Sam' });
    putOnBoard(docs(replica).board, loose, { by: 'Sam' });
    await labelCard(access, { notebookId: NOTEBOOK, pageId: loose, labelId: outdoor.id, on: true });
    expect(sectionOf(replica, loose)).toBe(scratch);
  });
});

describe('promoting a To Do line', () => {
  it('makes a page with the line’s id and text, a card with a link back, and turns the line into a card link', async () => {
    const { replica, access, scratch } = await setup();
    const source = await pageWithLine(replica, scratch);
    const result = await promoteTodoLine(access, { notebookId: NOTEBOOK, sourcePageId: source, lineId: 'line-a', by: 'Sam' });
    expect(result).toEqual({ pageId: 'line-a', number: 1 });
    expect(getNode(docs(replica).notebook, 'line-a')).toMatchObject({ name: 'Build a cold frame', parent: unfiledSectionId(NOTEBOOK) });
    const card = findCard(readBoard(docs(replica).board, docs(replica).notebook), 'line-a')!;
    expect(card.links.map((link) => [link.target, link.title])).toEqual([[looseleafTarget(source), 'Ideas']]);
    expect(listTodoLines(replica.doc(pageDocId(source)))).toEqual([]);
    const first = readPage(replica.doc(pageDocId(source))).containers[0]!;
    expect(first.kind === 'text' && first.body.content![0]!.content).toEqual([{ type: 'cardLink', attrs: { pageId: 'line-a' } }]);

    expect(await promoteTodoLine(access, { notebookId: NOTEBOOK, sourcePageId: source, lineId: 'line-a', by: 'Sam' })).toEqual(result);
    await expect(promoteTodoLine(access, { notebookId: NOTEBOOK, sourcePageId: source, lineId: 'nope', by: 'Sam' })).rejects.toThrow('has no To Do line with the id "nope"');
  });

  it('leaves the page the line was on modified, so clients read its lines again', async () => {
    const { replica, access, scratch } = await setup();
    const source = await pageWithLine(replica, scratch);
    docs(replica).notebook.getMap<Y.Map<unknown>>('nodes').get(source)!.set('modifiedAt', 1);
    await promoteTodoLine(access, { notebookId: NOTEBOOK, sourcePageId: source, lineId: 'line-a', by: 'Sam' });
    expect(getNode(docs(replica).notebook, source)!.modifiedAt).toBeGreaterThan(1);
  });

  it('makes a new card from a line written where an archived card’s link was', async () => {
    const { replica, access, scratch } = await setup();
    const source = await pageWithLine(replica, scratch);
    await promoteTodoLine(access, { notebookId: NOTEBOOK, sourcePageId: source, lineId: 'line-a', by: 'Sam' });
    archiveCard(docs(replica).board, 'line-a', 'Sam');
    // The person replaces the chip with new text on the same paragraph and tags it To Do, as the editor does.
    const page = replica.doc(pageDocId(source));
    const line = textContainerBodies(page)[0]!.get(0) as Y.XmlElement;
    page.transact(() => {
      line.delete(0, line.length);
      line.insert(0, [new Y.XmlText('Renew passport')]);
      const attrs = tagTodoLine(line.getAttributes(), { now: () => 500, newId: () => 'line-b' });
      for (const [name, value] of Object.entries(attrs)) line.setAttribute(name, value as string);
    });
    expect(listTodoLines(page).map((todo) => [todo.id, todo.text, todo.taggedAt])).toEqual([['line-b', 'Renew passport', 500]]);

    const result = await promoteTodoLine(access, { notebookId: NOTEBOOK, sourcePageId: source, lineId: 'line-b', by: 'Sam' });
    expect(result).toEqual({ pageId: 'line-b', number: 2 });
    const read = readBoard(docs(replica).board, docs(replica).notebook);
    expect(findCard(read, 'line-a')).toMatchObject({ title: 'Build a cold frame' });
    expect(findCard(read, 'line-a')!.archivedAt).not.toBeNull();
    expect(findCard(read, 'line-b')).toMatchObject({ title: 'Renew passport', archivedAt: null });
  });
});

describe('two replicas', () => {
  it('both put the same page on the board and end with one card holding what each then put on it', async () => {
    const { replica: a, scratch, outdoor, urgent } = await setup();
    const page = createPage(docs(a).notebook, { section: scratch, title: 'Shared page' });
    const b = forkReplica(a);
    const statuses = readBoard(docs(a).board, docs(a).notebook).statuses;
    const doing = statuses.find((status) => status.kind === 'doing')!;
    putOnBoard(docs(a).board, page, { by: 'Sam' });
    addComment(docs(a).board, page, 'Ordered the timber', 'Sam');
    await labelCard(accessTo(a), { notebookId: NOTEBOOK, pageId: page, labelId: urgent.id, on: true });
    addLink(docs(a).board, page, { target: 'https://example.com/timber', title: 'Timber' });
    putOnBoard(docs(b).board, page, { by: 'Agent' });
    addComment(docs(b).board, page, 'Measured the bed', 'Agent');
    await labelCard(accessTo(b), { notebookId: NOTEBOOK, pageId: page, labelId: outdoor.id, on: true });
    addLink(docs(b).board, page, { target: 'https://example.com/plan', title: 'Plan' });
    setCardDue(docs(b).board, page, '2026-12-01');
    moveCard(docs(b).board, page, { statusId: doing.id }, 'Agent');
    syncReplicas(a, b);
    expect(replicaBytes(a)).toEqual(replicaBytes(b));
    const read = readBoard(docs(a).board, docs(a).notebook);
    expect(read.cards.map((card) => [card.id, card.number])).toEqual([[page, 1]]);
    const card = read.cards[0]!;
    expect(card.comments.map((comment) => comment.body).sort()).toEqual(['Measured the bed', 'Ordered the timber']);
    expect([...card.labelIds].sort()).toEqual([outdoor.id, urgent.id].sort());
    expect(card.links.map((link) => link.title).sort()).toEqual(['Plan', 'Timber']);
    expect(card.due).toBe('2026-12-01');
    expect(card.statusId).toBe(doing.id);
    expect(card.activity.filter((entry) => entry.type === 'moved')).toHaveLength(1);
  });

  it.each([
    ['the deleting replica first', true],
    ['the editing replica first', false],
  ])('keep a comment deleted on one while the other edits it, syncing %s', async (_order, deleterFirst) => {
    const { replica: a, access } = await setup();
    const { pageId } = await addCard(access, { notebookId: NOTEBOOK, title: 'Shared card', by: 'Sam' });
    const secret = addComment(docs(a).board, pageId, 'The gate code is 4512', 'Sam');
    addComment(docs(a).board, pageId, 'Kept', 'Sam');
    const b = forkReplica(a);
    deleteComment(docs(a).board, pageId, secret);
    editComment(docs(b).board, pageId, secret, 'The gate code is 4512, ask Robin');
    addComment(docs(b).board, pageId, 'Added on the other', 'Agent');
    if (deleterFirst) syncReplicas(a, b);
    else syncReplicas(b, a);
    expect(replicaBytes(a)).toEqual(replicaBytes(b));
    const bodies = () => findCard(readBoard(docs(a).board, docs(a).notebook), pageId)!.comments.map((comment) => comment.body);
    expect(bodies().sort()).toEqual(['Added on the other', 'Kept']);
    expect(() => editComment(docs(a).board, pageId, secret, 'again')).toThrow('has no comment');
    expect(clearDeletedComments(docs(b).board)).toBe(1);
    syncReplicas(a, b);
    expect(replicaBytes(a)).toEqual(replicaBytes(b));
    expect(JSON.stringify(docs(a).board.getMap('cards').toJSON())).not.toContain('4512');
    expect(bodies().sort()).toEqual(['Added on the other', 'Kept']);
  });

  it('both make a card from the same line and keep the comments and moves made on each', async () => {
    const { replica: a, scratch } = await setup();
    const source = await pageWithLine(a, scratch);
    const b = forkReplica(a);
    const done = readBoard(docs(a).board, docs(a).notebook).statuses.find((status) => status.kind === 'done')!;
    await promoteTodoLine(accessTo(a), { notebookId: NOTEBOOK, sourcePageId: source, lineId: 'line-a', by: 'Phone' });
    addComment(docs(a).board, 'line-a', 'Done offline', 'Phone');
    moveCard(docs(a).board, 'line-a', { statusId: done.id }, 'Phone');
    await promoteTodoLine(accessTo(b), { notebookId: NOTEBOOK, sourcePageId: source, lineId: 'line-a', by: 'Agent' });
    addComment(docs(b).board, 'line-a', 'Picked up by the agent', 'Agent');
    syncReplicas(a, b);
    removeDuplicateCardLinks(b.doc(pageDocId(source)));
    syncReplicas(a, b);
    expect(replicaBytes(a)).toEqual(replicaBytes(b));
    const card = findCard(readBoard(docs(b).board, docs(b).notebook), 'line-a')!;
    expect(card.comments.map((comment) => comment.body).sort()).toEqual(['Done offline', 'Picked up by the agent']);
    expect(card.statusId).toBe(done.id);
    expect(card.links.map((link) => link.target)).toEqual([looseleafTarget(source)]);
  });

  it('both promote the same line and end with one page, one card and one link', async () => {
    const { replica: a, scratch } = await setup();
    const source = await pageWithLine(a, scratch);
    const b = forkReplica(a);
    await promoteTodoLine(accessTo(a), { notebookId: NOTEBOOK, sourcePageId: source, lineId: 'line-a', by: 'Sam' });
    await promoteTodoLine(accessTo(b), { notebookId: NOTEBOOK, sourcePageId: source, lineId: 'line-a', by: 'Agent' });
    syncReplicas(a, b);
    removeDuplicateCardLinks(a.doc(pageDocId(source)));
    syncReplicas(a, b);
    expect(replicaBytes(a)).toEqual(replicaBytes(b));
    const read = readBoard(docs(b).board, docs(b).notebook);
    expect(read.cards.map((card) => [card.id, card.title])).toEqual([['line-a', 'Build a cold frame']]);
    const pages = readTree(docs(b).notebook).children.flatMap((child) => (child.kind === 'section' ? child.pages.map((p) => p.id) : []));
    expect(pages.filter((id) => id === 'line-a')).toHaveLength(1);
    const first = readPage(b.doc(pageDocId(source))).containers[0]!;
    expect(first.kind === 'text' && first.body.content![0]!.content).toEqual([{ type: 'cardLink', attrs: { pageId: 'line-a' } }]);
  });

  it('both add a first card that makes the Unfiled section and end with one section holding both pages', async () => {
    const { replica: a } = await setup();
    const b = forkReplica(a);
    const fromA = await addCard(accessTo(a), { notebookId: NOTEBOOK, title: 'From A', by: 'Sam' });
    const fromB = await addCard(accessTo(b), { notebookId: NOTEBOOK, title: 'From B', by: 'Agent' });
    syncReplicas(a, b);
    expect(replicaBytes(a)).toEqual(replicaBytes(b));
    const unfiled = readTree(docs(a).notebook).children.filter((child) => child.name === 'Unfiled');
    expect(unfiled).toHaveLength(1);
    expect(unfiled[0]!.kind === 'section' && unfiled[0]!.pages.map((page) => page.id).sort()).toEqual([fromA.pageId, fromB.pageId].sort());
    expect(renumberDuplicateCards(docs(a).board)).toBe(1);
    syncReplicas(a, b);
    expect(readBoard(docs(b).board, docs(b).notebook).cards.map((card) => card.number).sort()).toEqual([1, 2]);
    expect(replicaBytes(a)).toEqual(replicaBytes(b));
  });

  it('keep a retitle on one and a move on the other', async () => {
    const { replica: a, access } = await setup();
    const { pageId } = await addCard(access, { notebookId: NOTEBOOK, title: 'Old title', by: 'Sam' });
    const b = forkReplica(a);
    renameNode(docs(a).notebook, pageId, 'New title');
    const done = readBoard(docs(b).board, docs(b).notebook).statuses.find((status) => status.kind === 'done')!;
    moveCard(docs(b).board, pageId, { statusId: done.id }, 'Agent');
    syncReplicas(a, b);
    expect(replicaBytes(a)).toEqual(replicaBytes(b));
    expect(findCard(readBoard(docs(a).board, docs(a).notebook), pageId)).toMatchObject({ title: 'New title', statusId: done.id });
  });

  it('both make a board on one notebook and end with one set of statuses holding what each changed', async () => {
    const a = new MemoryReplica();
    const b = new MemoryReplica();
    const boardA = await a.getDoc(boardDocId(NOTEBOOK));
    const boardB = await b.getDoc(boardDocId(NOTEBOOK));
    createBoard(boardA, { notebookId: NOTEBOOK, name: 'Home', takenKeys: [] });
    createBoard(boardB, { notebookId: NOTEBOOK, name: 'Home', takenKeys: [] });
    const [backlog, thisWeek, , blocked] = readBoard(boardA, new Y.Doc()).statuses;
    updateStatus(boardA, backlog!.id, { name: 'Someday' });
    archiveStatus(boardA, blocked!.id);
    updateStatus(boardB, thisWeek!.id, { name: 'Next', kind: 'doing' });
    createStatus(boardB, { name: 'Waiting' });
    createLabel(boardB, { name: 'Errands' });
    syncReplicas(a, b);
    expect(replicaBytes(a)).toEqual(replicaBytes(b));
    const read = readBoard(boardA, new Y.Doc());
    expect(read.statuses.map((status) => [status.name, status.kind])).toEqual([
      ['Someday', 'todo'],
      ['Next', 'doing'],
      ['In progress', 'doing'],
      ['Done', 'done'],
      ['Waiting', 'todo'],
    ]);
    expect(read.archivedStatuses.map((status) => status.name)).toEqual(['Blocked']);
    expect(read.labels.map((label) => label.name)).toEqual(['Errands']);
  });
});
