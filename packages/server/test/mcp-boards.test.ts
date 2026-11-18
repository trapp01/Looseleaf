import { describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  LIBRARY_DOC_ID,
  appendToPage,
  boardDocId,
  cardsInStatus,
  createGroup,
  createLabel,
  createNotebook,
  createPage,
  createSection,
  createStatus,
  getNode,
  keepAsLine,
  listTodoLines,
  markdownToBody,
  newId,
  notebookDocId,
  pageDocId,
  readBoard,
  readPage,
  unfiledSectionId,
} from '@looseleaf/model';
import { call, mcpClient, TestServer, waitFor } from './harness.js';

const DELAY_MS = 100;

interface Workshop {
  server: TestServer;
  client: Client;
  notebook: string;
  garden: string;
  bench: string;
  ideas: string;
  scope: string;
  run: (name: string, args?: Record<string, unknown>) => Promise<{ text: string; isError: boolean }>;
}

/**
 * Two notebooks: Workshop (sections Bench and Plans / Ideas, with a page
 * "Shed scope" in Ideas) and Garden. Workshop has the board WRK with the
 * labels Shed (tied to Bench) and Paint.
 */
async function workshop(options: { board?: boolean } = {}): Promise<Workshop> {
  const server = await TestServer.start({ mirrorDelayMs: DELAY_MS });
  const hub = server.current.hub;
  const ids = { notebook: '', garden: '', bench: '', ideas: '', scope: '' };
  await hub.withDoc(LIBRARY_DOC_ID, (doc) => {
    ids.notebook = createNotebook(doc, { name: 'Workshop' });
    ids.garden = createNotebook(doc, { name: 'Garden' });
  });
  await hub.withDoc(notebookDocId(ids.notebook), (doc) => {
    ids.bench = createSection(doc, { name: 'Bench', parent: null });
    ids.ideas = createSection(doc, { name: 'Ideas', parent: createGroup(doc, { name: 'Plans', parent: null }) });
    ids.scope = createPage(doc, { section: ids.ideas, title: 'Shed scope' });
  });
  await hub.withDoc(notebookDocId(ids.garden), (doc) => createSection(doc, { name: 'Beds', parent: null }));
  const client = await mcpClient(server);
  const run = (name: string, args: Record<string, unknown> = {}) => call(client, name, args);
  if (options.board !== false) {
    expect((await run('create_board', { notebook: 'workshop', key: 'wrk' })).text).toContain('with the key WRK');
    await run('create_label', { name: 'Shed', section: 'Bench' });
    await run('create_label', { name: 'Paint', color: 'red' });
  }
  return { server, client, run, ...ids };
}

/** Adds Markdown to a page as a client would, with To Do lines tagged a moment from now so they are newer than the board. */
async function writePage(server: TestServer, pageId: string, markdown: string): Promise<void> {
  const { body } = await markdownToBody(markdown, { stamp: { now: () => Date.now() + 5, newId } });
  await server.current.hub.withDoc(pageDocId(pageId), (doc) => appendToPage(doc, body));
}

async function boardOf(server: TestServer, notebook: string) {
  return readBoard(await server.storedDoc(boardDocId(notebook)), await server.storedDoc(notebookDocId(notebook)));
}

describe('the MCP board tools', () => {
  it('carry a task from a new card to done, the way the instructions ask', async () => {
    const { server, run, notebook, bench } = await workshop();
    const created = await run('create_card', {
      title: 'Fix the shed door',
      description: 'The hinge is loose after the storm.',
      labels: ['shed'],
      due: '2030-01-05',
      checklist: ['Buy hinges', 'Fit hinges', 'Paint the door'],
      links: [{ target: 'https://example.com/hinges', title: 'Hinge shop' }],
      author: 'Claude',
    });
    expect(created.isError).toBe(false);
    const pageId = /\(page id: ([\w-]+)\)/.exec(created.text)![1]!;
    expect(created.text).toBe(`Created WRK-1 "Fix the shed door" in Backlog (page id: ${pageId}).\nAddress: ${server.url}/#page=${pageId}\n`);
    // The Shed label is tied to Bench, so the page is filed there.
    expect(getNode(await server.storedDoc(notebookDocId(notebook)), pageId)?.parent).toBe(bench);

    expect((await run('move_card', { card: 'WRK-1', status: 'doing', author: 'Claude' })).text).toBe('Moved WRK-1 "Fix the shed door" to In progress (doing).\n');
    expect((await run('update_checklist', { card: 'wrk-1', check: ['buy hinges'], add: ['Oil the lock'] })).text).toBe(
      'Checklist of WRK-1 "Fix the shed door" is now 1/4 done.\n',
    );
    await run('add_comment', { card: `${server.url}/#page=${pageId}`, body: 'The old hinge is rusted through.', author: 'Claude' });
    await run('update_card', { card: 'WRK-1', title: 'Fix the shed door and lock', add_labels: ['Paint'], remove_labels: ['Shed'] });
    await run('add_link', { card: pageId, target: 'looseleaf:scopepage', title: 'Scope notes' });
    expect((await run('append_to_page', { page_id: 'WRK-1', markdown: 'Measured: 80 mm.' })).isError).toBe(false);

    const card = (await run('get_card', { card: 'WRK-1' })).text;
    expect(card).toContain('# WRK-1 Fix the shed door and lock');
    expect(card).toContain('- Board: Workshop');
    expect(card).toContain('- Status: In progress (doing)');
    expect(card).toContain('- Labels: Paint');
    expect(card).toContain('- Due: 2030-01-05');
    expect(card).toContain(`- Address: ${server.url}/#page=${pageId}`);
    expect(card).toContain(`- Id: ${pageId}`);
    expect(card).toContain('## Page\n\nThe hinge is loose after the storm.\n\n- [x] Buy hinges\n\n- [ ] Fit hinges');
    expect(card).toContain('Measured: 80 mm.');
    expect(card).toContain('## Checklist (1/4)');
    expect(card).toMatch(/- \[x\] Buy hinges \(line [\w-]+\)/);
    expect(card).toMatch(/- \[ \] Oil the lock \(line [\w-]+\)/);
    expect(card).toContain('- Hinge shop — https://example.com/hinges');
    expect(card).toContain('- Scope notes — page scopepage');
    expect(card).toContain('### Claude, ');
    expect(card).toContain('Claude moved it from Backlog to In progress');

    await run('move_card', { card: 'WRK-1', status: 'Done' });
    const done = (await run('get_board', { status: 'done' })).text;
    expect(done).toContain('## Done (done, 1 card)');
    expect(done).toContain('- WRK-1 Fix the shed door and lock · [Paint] · due 2030-01-05 · checklist 1/4 · 1 comment');
    expect(done).not.toContain('## Backlog');
    expect(done).not.toContain('## Inbox');

    // read_page takes the ref once the mirror has written the page, and append_to_page and read_page take a page address too.
    await waitFor(async () => (await run('read_page', { page_id: 'WRK-1' })).text.includes('Measured: 80 mm.'), 'read_page by ref');
    expect((await run('append_to_page', { page_id: `looseleaf://page/${pageId}`, markdown: 'Fitted.' })).isError).toBe(false);
    await waitFor(async () => (await run('read_page', { page_id: `${server.url}/#page=${pageId}` })).text.includes('Fitted.'), 'read_page by address');
  });

  it('turns an Inbox line into a card that replaces the line with a link and links back to the page', async () => {
    const { server, run, notebook, scope } = await workshop();
    await writePage(server, scope, 'Shed jobs:\n\n- [ ] Replace the window\n- [ ] Sweep the floor\n- [x] Clear the gutter');
    const board = (await run('get_board')).text;
    expect(board).toContain('## Inbox (2 lines)');
    const line = /- Replace the window · on "Shed scope" · line ([\w-]+)/.exec(board)![1]!;
    expect(board).toMatch(/- Sweep the floor · on "Shed scope" · line [\w-]+/);
    expect(board).not.toContain('Clear the gutter');

    const created = await run('create_card', { line, status: 'This week', labels: ['Shed'], due: '2030-03-01', author: 'Claude' });
    expect(created.text).toContain(`Created WRK-1 "Replace the window" from the line "Replace the window" in This week (page id: ${line}).`);
    const page = readPage(await server.storedDoc(pageDocId(scope)));
    expect(JSON.stringify(page)).toContain(`"cardLink","attrs":{"pageId":"${line}"}`);
    expect(listTodoLines(await server.storedDoc(pageDocId(scope))).map((todo) => todo.text)).toEqual(['Sweep the floor', 'Clear the gutter']);
    // A label with a tie moves the page out of the Unfiled section, where promoting a line files it.
    const node = getNode(await server.storedDoc(notebookDocId(notebook)), line)!;
    expect(node.parent).not.toBe(unfiledSectionId(notebook));

    const card = (await run('get_card', { card: 'WRK-1' })).text;
    expect(card).toContain('- Status: This week (todo)');
    expect(card).toContain('- Labels: Shed');
    expect(card).toContain('- Due: 2030-03-01');
    expect(card).toContain(`- Shed scope — page ${scope}`);
    const after = (await run('get_board')).text;
    expect(after).toContain('## Inbox (1 line)');
    expect(after).not.toMatch(/- Replace the window · on/);

    // Promoting the same line again finds nothing to promote.
    const again = await run('create_card', { line });
    expect(again.isError).toBe(true);
    expect(again.text).toBe(`No To Do line on a page of Workshop has the id "${line}". get_board lists the Inbox lines with their ids.`);
  });

  it('makes a card only from a line in the Inbox, and says why another line cannot be one', async () => {
    const { server, run, notebook, scope } = await workshop();
    const hub = server.current.hub;
    await writePage(server, scope, '- [ ] Paint the door\n- [x] Buy the paint\n- [ ] Oil the hinge');
    const { body: before } = await markdownToBody('- [ ] Old job', { stamp: { now: () => 1, newId } });
    await hub.withDoc(pageDocId(scope), (doc) => appendToPage(doc, before));
    const lines = listTodoLines(await server.storedDoc(pageDocId(scope)));
    const id = (text: string) => lines.find((line) => line.text === text)!.id!;
    await hub.withDoc(pageDocId(scope), (doc) => keepAsLine(doc, id('Oil the hinge')));
    await run('create_card', { title: 'Shed door', checklist: ['Sand it'] });
    const card = (await boardOf(server, notebook)).cards[0]!;
    const step = listTodoLines(await server.storedDoc(pageDocId(card.id)))[0]!.id!;

    const instead = 'Make the card from a title instead, or choose a line from the Inbox in get_board.';
    const cases: Array<[string, string]> = [
      [step, `The line "Sand it" is on the checklist of WRK-1, and a card's checklist lines stay on its page. ${instead}`],
      [id('Buy the paint'), `The line "Buy the paint" is ticked, so it is done and not in the Inbox. ${instead}`],
      [id('Oil the hinge'), `Someone chose "Keep it as a line" for the line "Oil the hinge", so it stays out of the Inbox. ${instead}`],
      [id('Old job'), `The line "Old job" was tagged To Do before the board was made, so it is not in the Inbox. ${instead}`],
    ];
    for (const [line, message] of cases) expect(await run('create_card', { line })).toEqual({ text: message, isError: true });
    expect((await boardOf(server, notebook)).cards).toHaveLength(1);
    expect((await run('create_card', { line: id('Paint the door') })).isError).toBe(false);
  });

  it('leaves a page modified when its checklist is only ticked, or a line on it becomes a card', async () => {
    const { server, run, notebook, scope } = await workshop();
    await run('create_card', { title: 'Shed door', checklist: ['Sand it'] });
    const card = (await boardOf(server, notebook)).cards[0]!;
    const modifiedAt = async (pageId: string) => getNode(await server.storedDoc(notebookDocId(notebook)), pageId)!.modifiedAt;
    const ticked = await modifiedAt(card.id);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await run('update_checklist', { card: 'WRK-1', check: ['Sand it'] });
    expect(await modifiedAt(card.id)).toBeGreaterThan(ticked);

    await writePage(server, scope, '- [ ] Paint the door');
    const promoted = await modifiedAt(scope);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const line = listTodoLines(await server.storedDoc(pageDocId(scope)))[0]!.id!;
    await run('create_card', { line });
    expect(await modifiedAt(scope)).toBeGreaterThan(promoted);
  });

  it('lists the matches when a board, status or label name fits several', async () => {
    const { server, run, notebook } = await workshop();
    const hub = server.current.hub;
    const second = await hub.withDoc(LIBRARY_DOC_ID, (doc) => createNotebook(doc, { name: 'workshop' }));
    await run('create_board', { notebook: second, key: 'wk2' });
    await hub.withDoc(boardDocId(notebook), (doc) => {
      createStatus(doc, { name: 'done', kind: 'done' });
      createLabel(doc, { name: 'paint', color: 'blue' });
    });
    const board = await boardOf(server, notebook);
    const done = board.statuses.filter((status) => status.name.toLowerCase() === 'done');
    const paint = board.labels.filter((label) => label.name.toLowerCase() === 'paint');

    expect(await run('get_board', { board: 'Workshop' })).toEqual({
      text: `Several boards match "Workshop": Workshop (key WRK, notebook id ${notebook}), workshop (key WK2, notebook id ${second}). Give the notebook id.`,
      isError: true,
    });
    expect((await run('get_board', { board: 'wrk' })).isError).toBe(false);
    await run('create_card', { board: 'WRK', title: 'Gate' });
    expect(await run('move_card', { card: 'WRK-1', status: 'Done' })).toEqual({
      text: `Several statuses are called "Done": Done (done, id ${done[0]!.id}), done (done, id ${done[1]!.id}). Give the status id.`,
      isError: true,
    });
    expect((await run('move_card', { card: 'WRK-1', status: done[1]!.id })).isError).toBe(false);
    expect(await run('update_card', { card: 'WRK-1', add_labels: ['Paint'] })).toEqual({
      text: `Several labels are called "Paint": Paint (red, id ${paint[0]!.id}), paint (blue, id ${paint[1]!.id}). Give the label id.`,
      isError: true,
    });
    expect((await run('update_card', { card: 'WRK-1', add_labels: [paint[1]!.id] })).isError).toBe(false);
  });

  it('places cards by place and by position, and leaves an archived card where it is until it is restored', async () => {
    const { server, run, notebook } = await workshop();
    for (const title of ['A', 'B', 'C']) await run('create_card', { title, place: 'bottom' });
    await run('create_card', { title: 'First', place: 'top' });
    await run('move_card', { card: 'WRK-1', status: 'Backlog', position: 2 });
    const titles = async () => {
      const board = await boardOf(server, notebook);
      return cardsInStatus(board, board.statuses[0]!.id).map((card) => card.title);
    };
    expect(await titles()).toEqual(['First', 'A', 'B', 'C']);
    await run('move_card', { card: 'WRK-1', status: 'Backlog' });
    expect(await titles()).toEqual(['First', 'B', 'C', 'A']);
    expect((await run('archive_card', { card: 'WRK-1' })).text).toBe('Archived WRK-1 "A".\n');
    expect(await titles()).toEqual(['First', 'B', 'C']);
    const refused = await run('move_card', { card: 'WRK-1', status: 'Backlog', place: 'top' });
    expect(refused).toEqual({ text: 'WRK-1 "A" is archived. Restore it with archive_card and restore: true, then move it.', isError: true });
    expect((await run('search_cards', { query: 'A', include_archived: true })).text).toContain('WRK-1 A — Backlog (archived)');
    expect((await run('archive_card', { card: 'WRK-1', restore: true })).text).toBe('Restored WRK-1 "A".\n');
    await run('move_card', { card: 'WRK-1', status: 'Backlog', place: 'top' });
    expect(await titles()).toEqual(['A', 'First', 'B', 'C']);
  });

  it('searches card titles, pages, labels and comments across boards with filters', async () => {
    const { run, server } = await workshop();
    await run('create_board', { notebook: 'Garden' });
    await run('create_card', { board: 'WRK', title: 'Fix the gate', labels: ['Shed'], status: 'doing' });
    await run('create_card', { board: 'workshop', title: 'Order paint', description: 'Ask about the gate colour' });
    await run('create_card', { board: 'Garden', title: 'Gate hinges for the beds', due: '2030-02-01' });
    await run('add_comment', { card: 'WRK-2', body: 'Prefer the green tin.' });

    const all = (await run('search_cards', { query: 'gate' })).text;
    expect(all).toContain('3 matching cards.');
    expect(all).toContain('- WRK-1 Fix the gate · [Shed] — In progress');
    expect(all).toContain('- GAR-1 Gate hinges for the beds · due 2030-02-01 — Backlog');
    expect((await run('search_cards', { query: 'gate', board: 'wrk', status: 'doing' })).text).toContain('1 matching card.');
    expect((await run('search_cards', { query: 'green tin' })).text).toContain('WRK-2 Order paint');
    expect((await run('search_cards', { label: 'shed' })).text).toContain('1 matching card.');
    expect((await run('search_cards', { due_by: '2030-12-31' })).text).toContain('GAR-1');
    expect((await run('search_cards', { query: 'gate', limit: 1 })).text).toContain('Showing 1 of 3 matching cards.');
    expect((await run('search_cards', { query: 'nothing-like-this' })).text).toContain('No cards match');

    const list = (await run('list_boards')).text;
    expect(list).toContain('## Workshop (WRK)\nNotebook id: ');
    expect(list).toContain('Statuses: Backlog (todo, 1) → This week (todo, 0) → In progress (doing, 1) → Blocked (doing, 0) → Done (done, 0)');
    expect(list).toContain('Labels: Shed, Paint');
    expect(list).toContain('## Garden (GAR)');
    expect(server.url).not.toBe('');
  });

  it('adds a status where asked, and a label tied to a section by its path', async () => {
    const { run, server, notebook, ideas } = await workshop();
    expect((await run('create_status', { name: 'In review', kind: 'doing', position: 4 })).text).toBe(
      'Added the status In review to Workshop. Its statuses are now: Backlog → This week → In progress → In review → Blocked → Done.\n',
    );
    expect((await run('create_label', { name: 'Ideas', section: 'plans / ideas' })).text).toBe('Added the lime label Ideas to Workshop, tied to the section Plans / Ideas.\n');
    const created = await run('create_card', { title: 'Sketch a bigger shed', labels: ['Ideas'] });
    const pageId = /\(page id: ([\w-]+)\)/.exec(created.text)![1]!;
    expect(getNode(await server.storedDoc(notebookDocId(notebook)), pageId)?.parent).toBe(ideas);
    // Without a tied label the page goes to the Unfiled section.
    const loose = await run('create_card', { title: 'Loose card' });
    const loosePage = /\(page id: ([\w-]+)\)/.exec(loose.text)![1]!;
    expect(getNode(await server.storedDoc(notebookDocId(notebook)), loosePage)?.parent).toBe(unfiledSectionId(notebook));
  });

  it('answers a mistake the caller can fix with what to do next', async () => {
    const { run, server, notebook } = await workshop();
    await run('create_card', { title: 'A', checklist: ['Step one'] });
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ['get_card', { card: 'WRK-99' }, 'Workshop has no card WRK-99. Find cards with search_cards.'],
      ['get_card', { card: 'ZZZ-1' }, 'No board has the key ZZZ. The boards are: Workshop (WRK).'],
      ['get_card', { card: 'the shed one' }, 'is not a card ref such as DEE-12'],
      ['get_card', { card: 'nopagehere' }, 'is not a card ref such as DEE-12, nor the page id or page address of a card'],
      ['read_page', { page_id: 'WRK-99' }, 'Workshop has no card WRK-99'],
      ['append_to_page', { page_id: 'ZZZ-1', markdown: 'x' }, 'No board has the key ZZZ'],
      ['move_card', { card: 'WRK-1', status: 'Shipping' }, "This board's statuses are: Backlog (todo), This week (todo), In progress (doing), Blocked (doing), Done (done)."],
      ['create_card', { title: 'B', labels: ['Roof'] }, "This board's labels are: Shed, Paint. Add one with create_label."],
      ['create_card', { title: 'B', due: 'tomorrow' }, 'Write a day as YYYY-MM-DD'],
      ['create_card', { title: 'B', due: '2030-02-31' }, '"2030-02-31" is not a day'],
      ['create_card', { title: '  ' }, 'create_card needs a title that is not empty.'],
      ['create_card', {}, 'create_card needs a title that is not empty.'],
      ['create_card', { line: 'noline' }, 'No To Do line on a page of Workshop has the id "noline". get_board lists the Inbox lines with their ids.'],
      ['create_card', { title: 'B', colour: 'red' }, 'create_card has no argument "colour"'],
      ['create_card', { title: 'B', place: 'middle' }, '"place" must be one of: top, bottom.'],
      ['create_card', { title: 'B', links: [{ target: 'ftp://x', title: 'x' }] }, 'is not a link target'],
      ['create_card', { title: 'B', links: [{ target: 'https://x' }] }, '"links[0]" needs "title"'],
      ['create_card', { title: 'B', labels: 'Shed' }, '"labels" must be a list.'],
      ['update_card', { card: 'WRK-1', description: 'New text' }, 'update_card has no argument "description"'],
      ['update_checklist', { card: 'WRK-1', check: ['Nope'] }, 'The card\'s page has no To Do line "Nope". Its lines are: "Step one".'],
      ['update_checklist', { card: 'WRK-1', remove: ['Step one'] }, 'update_checklist has no argument "remove"'],
      ['move_card', { card: 'WRK-1', status: 'Done', position: 0 }, '"position" must be at least 1.'],
      ['archive_card', { card: 'WRK-1', restore: 'yes' }, '"restore" must be true or false.'],
      ['search_cards', { due_by: 'next week' }, '"next week" is not a day'],
      ['get_card', { card: 'WRK-1', constructor: 'x' }, 'get_card has no argument "constructor"'],
      ['create_status', { name: 'done', kind: 'done' }, 'already has a status called "done"'],
      ['create_status', { name: 'Later', kind: 'someday' }, '"kind" must be one of: todo, doing, done.'],
      ['create_label', { name: 'shed' }, 'already has a label called "shed"'],
      ['create_label', { name: 'Roof', section: 'Attic' }, 'The notebook has no section called "Attic". Its sections are: Bench, Plans / Ideas, Unfiled.'],
      ['create_board', { notebook: 'Workshop' }, 'Workshop already has a board, with the key WRK. A notebook has one board; see it with get_board.'],
      ['create_board', { notebook: 'Attic' }, 'No notebook is called "Attic". The notebooks are: Workshop, Garden.'],
      ['get_board', { board: 'Nope' }, 'No board is called "Nope". The boards are: Workshop (WRK).'],
    ];
    for (const [name, args, message] of cases) {
      const answer = await run(name, args);
      expect(answer.isError, `${name} ${JSON.stringify(args)}`).toBe(true);
      expect(answer.text).toContain(message);
    }
    expect((await boardOf(server, notebook)).cards).toHaveLength(1);
  });

  it('asks which board when there are several, and needs none named when there is one', async () => {
    const { run } = await workshop({ board: false });
    expect((await run('create_card', { title: 'A' })).text).toBe('There are no boards yet. Make one on a notebook with create_board.');
    expect((await run('create_board', { notebook: 'Workshop' })).text).toBe(
      'Made the board of Workshop with the key WOR and the statuses Backlog, This week, In progress, Blocked and Done.\n',
    );
    expect((await run('create_card', { title: 'A' })).isError).toBe(false);
    await run('create_board', { notebook: 'Garden', key: 'wor' });
    expect((await run('list_boards')).text).toContain('## Garden (WOR2)');
    expect((await run('create_card', { title: 'B' })).text).toBe('Say which board: Workshop (WOR), Garden (WOR2).');
  });
});
