import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  addComment,
  addLink,
  archiveCard,
  archiveStatus,
  archivedCards,
  boardKeyRepairs,
  cardPageIds,
  cardsInStatus,
  createBoard,
  createLabel,
  createPage,
  createSection,
  createStatus,
  deleteLabel,
  deleteNode,
  findCard,
  formatCardRef,
  looseleafTarget,
  moveCard,
  moveStatus,
  parseCardRef,
  parseLinkTarget,
  putOnBoard,
  readBoard,
  readBoardMeta,
  renameNode,
  renderBoard,
  renderCard,
  restoreCard,
  restoreNode,
  searchCards,
  setCardDue,
  suggestBoardKey,
  type TodoLine,
} from '../src/index.js';

/** A notebook with one section and a board on it. */
function setup() {
  const notebook = new Y.Doc();
  const section = createSection(notebook, { name: 'Projects', parent: null });
  const board = new Y.Doc();
  createBoard(board, { notebookId: 'nb1', name: 'Home projects', takenKeys: [], now: 500 });
  const page = (title: string) => createPage(notebook, { section, title });
  return { notebook, board, section, page };
}

function titles(board: Y.Doc, notebook: Y.Doc, statusName: string): string[] {
  const read = readBoard(board, notebook);
  const status = read.statuses.find((candidate) => candidate.name === statusName)!;
  return cardsInStatus(read, status.id).map((card) => card.title);
}

function statusId(board: Y.Doc, notebook: Y.Doc, name: string): string {
  return readBoard(board, notebook).statuses.find((status) => status.name === name)!.id;
}

describe('board keys', () => {
  it('makes a board with a key, a created time and the default statuses', () => {
    const { board, notebook } = setup();
    expect(readBoardMeta(board)).toEqual({ key: 'HP', createdAt: 500, unfiledSection: null });
    expect(readBoard(board, notebook).statuses.map((status) => [status.name, status.kind])).toEqual([
      ['Backlog', 'todo'],
      ['This week', 'todo'],
      ['In progress', 'doing'],
      ['Blocked', 'doing'],
      ['Done', 'done'],
    ]);
    expect(() => createBoard(board, { notebookId: 'nb1', name: 'Again', takenKeys: [] })).toThrow('already has a board, with the key HP');
  });

  it('takes the key asked for unless another board has it', () => {
    const doc = new Y.Doc();
    expect(createBoard(doc, { notebookId: 'nb2', name: 'Kitchen', key: 'hp', takenKeys: ['HP'] }).key).toBe('HP2');
  });

  it('suggests initials for several words and the first letters for one', () => {
    expect(suggestBoardKey('Driver app iOS', [])).toBe('DAI');
    expect(suggestBoardKey('Garden', [])).toBe('GAR');
    expect(suggestBoardKey('123', [])).toBe('BRD');
  });

  it('repairs two boards that took the same key, the older keeps it, and leaves a key only one board uses', () => {
    const repairs = boardKeyRepairs([
      { notebookId: 'b', key: 'WEB', createdAt: 20 },
      { notebookId: 'a', key: 'WEB', createdAt: 10 },
      { notebookId: 'c', key: 'WEB2', createdAt: 5 },
    ]);
    expect(repairs).toEqual([{ notebookId: 'b', key: 'WEB3' }]);
    expect(boardKeyRepairs([{ notebookId: 'a', key: 'WEB', createdAt: 1 }])).toEqual([]);
  });
});

describe('cards', () => {
  it('puts pages on the first todo status at the top, numbered from 1, titled by the page', () => {
    const { board, notebook, page } = setup();
    const a = page('Fix the gate');
    const b = page('Paint the shed');
    expect(putOnBoard(board, a, { by: 'Sam' })).toBe(1);
    expect(putOnBoard(board, b, { by: 'Sam' })).toBe(2);
    putOnBoard(board, page('Last'), { place: 'bottom', by: 'Sam' });
    expect(titles(board, notebook, 'Backlog')).toEqual(['Paint the shed', 'Fix the gate', 'Last']);
    renameNode(notebook, a, 'Fix the side gate');
    expect(findCard(readBoard(board, notebook), a)?.title).toBe('Fix the side gate');
  });

  it('keeps one card when a page is put on the board twice, and restores an archived one', () => {
    const { board, notebook, page } = setup();
    const a = page('Fix the gate');
    putOnBoard(board, a, { by: 'Sam' });
    archiveCard(board, a, 'Sam');
    expect(putOnBoard(board, a, { by: 'Sam' })).toBe(1);
    const card = findCard(readBoard(board, notebook), a)!;
    expect(card.archivedAt).toBeNull();
    expect(card.activity.map((entry) => entry.type)).toEqual(['created', 'archived', 'restored']);
  });

  it('moves a card between statuses and records the move, but not a reorder', () => {
    const { board, notebook, page } = setup();
    const a = page('A');
    putOnBoard(board, a, { by: 'Sam' });
    putOnBoard(board, page('B'), { by: 'Sam' });
    moveCard(board, a, { statusId: statusId(board, notebook, 'Backlog'), place: 'bottom' }, 'Sam');
    expect(titles(board, notebook, 'Backlog')).toEqual(['B', 'A']);
    moveCard(board, a, { statusId: statusId(board, notebook, 'In progress') }, 'Agent');
    const card = findCard(readBoard(board, notebook), a)!;
    expect(card.activity.map((entry) => entry.type)).toEqual(['created', 'moved']);
    expect(card.activity[1]).toMatchObject({ by: 'Agent', from: 'Backlog', to: 'In progress' });
  });

  it('archives and restores a card, and hides the cards of an archived status', () => {
    const { board, notebook, page } = setup();
    const a = page('A');
    const b = page('B');
    putOnBoard(board, a, { by: 'Sam' });
    putOnBoard(board, b, { by: 'Sam' });
    archiveCard(board, a, 'Sam');
    expect(titles(board, notebook, 'Backlog')).toEqual(['B']);
    expect(cardPageIds(readBoard(board, notebook))).toEqual(new Set([b]));
    restoreCard(board, a, 'Sam');
    expect(titles(board, notebook, 'Backlog')).toEqual(['B', 'A']);
    archiveStatus(board, statusId(board, notebook, 'Backlog'));
    expect(archivedCards(readBoard(board, notebook)).map((card) => card.id).sort()).toEqual([a, b].sort());
  });

  it('hides the card of a deleted page and shows it again when the page is restored', () => {
    const { board, notebook, page } = setup();
    const a = page('Gone for now');
    putOnBoard(board, a, { by: 'Sam' });
    deleteNode(notebook, a);
    let read = readBoard(board, notebook);
    expect(read.cards).toEqual([]);
    expect(read.hiddenCards.map((card) => [card.id, card.title, card.sectionId])).toEqual([[a, 'Gone for now', null]]);
    restoreNode(notebook, a);
    read = readBoard(board, notebook);
    expect(read.cards.map((card) => card.id)).toEqual([a]);
    expect(readBoard(board, new Y.Doc()).hiddenCards.map((card) => card.title)).toEqual(['']);
  });

  it('keeps labels, due day, comments and links on a card', () => {
    const { board, notebook, page } = setup();
    const outdoor = createLabel(board, { name: 'Outdoor', section: 'sec-1' });
    const tools = createLabel(board, { name: 'Tools' });
    const a = page('Sharpen the mower');
    putOnBoard(board, a, { labelIds: [outdoor.id, tools.id], by: 'Sam' });
    setCardDue(board, a, '2031-04-02');
    addComment(board, a, 'Blade is chipped', 'Agent');
    addLink(board, a, { target: looseleafTarget('pg9'), title: 'Notes' });
    addLink(board, a, { target: looseleafTarget('pg9'), title: 'Mower notes' });
    deleteLabel(board, tools.id);
    const read = readBoard(board, notebook);
    const card = findCard(read, a)!;
    expect(read.labels.map((label) => [label.name, label.section])).toEqual([['Outdoor', 'sec-1']]);
    expect(card.due).toBe('2031-04-02');
    expect(card.comments.map((comment) => comment.body)).toEqual(['Blade is chipped']);
    expect(card.links.map((link) => link.title)).toEqual(['Mower notes']);
  });

  it('moves a status among the others', () => {
    const { board, notebook } = setup();
    const review = createStatus(board, { name: 'In review', kind: 'doing' });
    moveStatus(board, review.id, 3);
    expect(readBoard(board, notebook).statuses.map((status) => status.name)).toEqual(['Backlog', 'This week', 'In progress', 'In review', 'Blocked', 'Done']);
  });
});

describe('refs', () => {
  it('reads card refs and link targets', () => {
    expect(formatCardRef('HP', 12)).toBe('HP-12');
    expect(parseCardRef('hp-12')).toEqual({ key: 'HP', number: 12 });
    expect(parseCardRef('http://nas:8421/board/HP-12')).toEqual({ key: 'HP', number: 12 });
    expect(parseCardRef('#A2-7')).toEqual({ key: 'A2', number: 7 });
    expect(parseCardRef('twelve')).toBeNull();
    expect(parseCardRef('IFCI4HLFG2UG0PZLU6V-9')).toBeNull();
    expect(parseLinkTarget('looseleaf:GjCU_n-8w')).toEqual({ kind: 'page', pageId: 'GjCU_n-8w' });
    expect(parseLinkTarget('https://example.com/pr/4')).toEqual({ kind: 'url', url: 'https://example.com/pr/4' });
    expect(parseLinkTarget('javascript:alert(1)')).toBeNull();
  });
});

describe('search and rendering', () => {
  function sample() {
    const { board, notebook, page } = setup();
    const outdoor = createLabel(board, { name: 'Outdoor' });
    const fence = page('Fence repair');
    const shed = page('Shed roof');
    putOnBoard(board, fence, { labelIds: [outdoor.id], due: '2031-01-05', by: 'Sam' });
    putOnBoard(board, shed, { by: 'Sam' });
    addComment(board, fence, 'Bought new posts', 'Agent');
    addLink(board, fence, { target: looseleafTarget('pg1'), title: 'Measurements' });
    const pageText = new Map([
      [fence, 'Three posts lean after the storm'],
      [shed, 'Check the fence line first'],
    ]);
    const checklist: TodoLine[] = [{ id: 'line-1', text: 'Dig out the old posts', checked: true, taggedAt: 600, inbox: true }];
    return { board, notebook, outdoor, fence, shed, pageText, checklists: new Map([[fence, checklist]]) };
  }

  it('finds cards by every word in the title, page, comments and labels, title matches first', () => {
    const { board, notebook, outdoor, fence, shed, pageText } = sample();
    const read = readBoard(board, notebook);
    expect(searchCards(read, { query: 'fence' }, pageText).map((card) => card.id)).toEqual([fence, shed]);
    expect(searchCards(read, { query: 'posts storm' }, pageText).map((card) => card.id)).toEqual([fence]);
    expect(searchCards(read, { query: 'storm' }).map((card) => card.id)).toEqual([]);
    expect(searchCards(read, { labelId: outdoor.id }).map((card) => card.id)).toEqual([fence]);
    expect(searchCards(read, { dueBy: '2031-01-04' })).toEqual([]);
    archiveCard(board, fence, 'Sam');
    expect(searchCards(readBoard(board, notebook), { query: 'repair' })).toEqual([]);
    expect(searchCards(readBoard(board, notebook), { query: 'repair', includeArchived: true })).toHaveLength(1);
  });

  it('renders the board at a glance with its Inbox', () => {
    const { board, notebook, checklists } = sample();
    const text = renderBoard(readBoard(board, notebook), {
      name: 'Home projects',
      checklists,
      inbox: [{ id: 'line-7', text: 'Order gravel', taggedAt: 900, pageId: 'p7', pageTitle: 'Driveway' }],
    });
    expect(text).toContain('# Home projects (HP)');
    expect(text).toContain('## Inbox (1 line)\n\n- Order gravel · on "Driveway" · line line-7');
    expect(text).toContain('## Backlog (todo, 2 cards)');
    expect(text).toContain('- HP-1 Fence repair · [Outdoor] · due 2031-01-05 · checklist 1/1 · 1 comment');
    expect(text).toContain('## Done (done, 0 cards)');
    expect(renderBoard(readBoard(board, notebook), { name: 'Home projects', cardsPerStatus: 1 })).toContain('- … and 1 more');
  });

  it('renders everything on a card, with its page and checklist', () => {
    const { board, notebook, fence, checklists } = sample();
    const read = readBoard(board, notebook);
    const text = renderCard(read, findCard(read, fence)!, {
      name: 'Home projects',
      baseUrl: 'http://nas:8421/',
      checklists,
      page: 'Three posts lean after the storm',
      linkedText: new Map([[looseleafTarget('pg1'), 'Posts are 2.4 m apart']]),
    });
    expect(text).toContain('# HP-1 Fence repair');
    expect(text).toContain('- Status: Backlog (todo)');
    expect(text).toContain('- Position: 2 of 2 in Backlog');
    expect(text).toContain(`- Address: http://nas:8421/#page=${fence}`);
    expect(text).toContain('## Page\n\nThree posts lean after the storm');
    expect(text).toContain('## Checklist (1/1)\n\n- [x] Dig out the old posts (line line-1)');
    expect(text).toContain('- Measurements — page pg1');
    expect(text).toContain('  > Posts are 2.4 m apart');
    expect(text).toContain('### Agent, ');
    expect(text).toContain('Sam created this card in Backlog');
  });
});
