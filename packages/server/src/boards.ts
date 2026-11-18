/**
 * Where the server knows what a board is, through `model` only: finding a
 * board or a card from what a caller typed, reading a board with its Inbox
 * and checklists, reading a card's page, and the repairs a server runs after
 * every change it stores (duplicate card numbers, clashing board keys,
 * the text of deleted comments, duplicate card links). Docs are read and changed through `Hub.withDoc`, so
 * a change is stored and reaches every connected client like an edit made in
 * the web client; bulk reads come from the store, as the mirror's do. It
 * knows nothing about MCP; the wording of the board tools lives in the
 * `mcp-board-*` files.
 */
import * as Y from 'yjs';
import {
  LIBRARY_DOC_ID,
  boardDocId,
  boardKeyRepairs,
  cardPageIds,
  clearDeletedComments,
  exportPage,
  extractPageText,
  findCard,
  formatCardRef,
  inboxLines,
  listNotebooks,
  listTodoLines,
  livePages,
  notebookDocId,
  notebookIdOfBoardDoc,
  pageDocId,
  pageIdFromAppAddress,
  pageIdFromHash,
  parseCardRef,
  readBoard,
  readBoardMeta,
  readTree,
  removeDuplicateCardLinks,
  renumberDuplicateCards,
  setBoardKey,
  type BoardSnapshot,
  type Card,
  type InboxLine,
  type Label,
  type NotebookEntry,
  type Status,
  type TodoLine,
  type TreeChild,
} from '@looseleaf/model';
import type { DiskStore } from './disk-store.js';
import type { Hub } from './hub.js';
import { TodoLineIndex } from './todo-line-index.js';

const PAGE_PREFIX = 'pg:';
const BOARD_PREFIX = 'board:';

/** A request the caller can fix: an unknown board, card, status or label, or a value that makes no sense. Its message says what to do next. */
export class CallerError extends Error {}

/** A board as callers name it: by its key or its notebook's name. */
export interface BoardEntry {
  notebookId: string;
  /** The notebook's name, which is the board's name. */
  name: string;
  key: string;
}

export interface OpenCard {
  entry: BoardEntry;
  board: BoardSnapshot;
  card: Card;
  ref: string;
}

export class Boards {
  private readonly index: TodoLineIndex;
  /** The key and created time of every board doc the store holds, deleted notebooks' included, by notebook id. */
  private readonly keys = new Map<string, { key: string; createdAt: number }>();
  /** Key repairs run one at a time, so two never pick the same free key. */
  private keyRepairs: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(
    private readonly hub: Hub,
    private readonly store: DiskStore,
  ) {
    this.index = new TodoLineIndex(store);
  }

  /** The hub as `model`'s `DocAccess`, for the changes that span docs (`addCard`, `labelCard`, `promoteTodoLine`). */
  get access(): Hub {
    return this.hub;
  }

  /** Builds the To Do line index in the background, renumbers duplicate cards and repairs clashing keys left by a previous run. */
  start(): void {
    this.index.start();
    void this.keyWork(async () => {
      for (const docId of await this.store.listDocs()) {
        const notebookId = docId.startsWith(BOARD_PREFIX) ? notebookIdOfBoardDoc(docId) : null;
        if (notebookId === null) continue;
        const meta = await this.hub.withDoc(docId, (doc) => {
          renumberDuplicateCards(doc);
          clearDeletedComments(doc);
          return readBoardMeta(doc);
        });
        if (meta !== null) this.keys.set(notebookId, meta);
      }
      await this.repairKeys();
    });
  }

  /**
   * Called after a doc update is on disk. Marks a page for the line index and
   * starts the repair for the doc: card numbers and keys for a board doc,
   * card links for a page doc. It must not throw or block.
   */
  docStored(docId: string): void {
    if (this.closed) return;
    this.index.docStored(docId);
    this.repair(docId).catch((error: unknown) => console.error(`Could not repair doc "${docId}" after a change`, error));
  }

  /** Stops starting repairs and waits for those in progress and for the line index. */
  async close(): Promise<void> {
    this.closed = true;
    await this.keyRepairs;
    await this.index.close();
  }

  private async repair(docId: string): Promise<void> {
    if (docId.startsWith(PAGE_PREFIX)) {
      await this.hub.withDoc(docId, removeDuplicateCardLinks);
      return;
    }
    const notebookId = docId.startsWith(BOARD_PREFIX) ? notebookIdOfBoardDoc(docId) : null;
    if (notebookId === null) return;
    const meta = await this.hub.withDoc(docId, (doc) => {
      renumberDuplicateCards(doc);
      clearDeletedComments(doc);
      return readBoardMeta(doc);
    });
    if (meta === null) return;
    await this.keyWork(async () => {
      const known = this.keys.get(notebookId);
      if (known?.key === meta.key && known.createdAt === meta.createdAt) return;
      this.keys.set(notebookId, meta);
      await this.repairKeys().catch((error: unknown) => {
        this.keys.delete(notebookId);
        throw error;
      });
    });
  }

  /** Runs work on the board keys after the work queued before it, so every repair sees every key the start-up read found. */
  private keyWork(work: () => Promise<void>): Promise<void> {
    this.keyRepairs = this.keyRepairs
      .then(work)
      .catch((error: unknown) => console.error('Could not repair clashing board keys; they are checked again at the next board change', error));
    return this.keyRepairs;
  }

  /** Gives every board that shares a key with an older one a key of its own. */
  private async repairKeys(): Promise<void> {
    const boards = [...this.keys].map(([notebookId, meta]) => ({ notebookId, ...meta }));
    for (const { notebookId, key } of boardKeyRepairs(boards)) {
      if (this.closed) return;
      const meta = await this.hub.withDoc(boardDocId(notebookId), (doc) => {
        setBoardKey(doc, key);
        return readBoardMeta(doc);
      });
      if (meta !== null) this.keys.set(notebookId, meta);
    }
  }

  /** The key of every board on the server, deleted notebooks' included, as the store holds them now. */
  async takenKeys(): Promise<string[]> {
    const keys: string[] = [];
    for (const docId of await this.store.listDocs()) {
      if (!docId.startsWith(BOARD_PREFIX)) continue;
      const meta = await this.hub.withDoc(docId, readBoardMeta);
      if (meta !== null) keys.push(meta.key);
    }
    return keys;
  }

  /** Notebooks that are not deleted, in notebook order. */
  notebooks(): Promise<NotebookEntry[]> {
    return this.hub.withDoc(LIBRARY_DOC_ID, (doc) => listNotebooks(doc));
  }

  /** Every board on a notebook that is not deleted, in notebook order. */
  async list(): Promise<BoardEntry[]> {
    const stored = new Set(await this.store.listDocs());
    const entries: BoardEntry[] = [];
    for (const notebook of await this.notebooks()) {
      if (!stored.has(boardDocId(notebook.id))) continue;
      const meta = await this.hub.withDoc(boardDocId(notebook.id), readBoardMeta);
      if (meta !== null) entries.push({ notebookId: notebook.id, name: notebook.name, key: meta.key });
    }
    return entries;
  }

  /**
   * The board a caller named by key or notebook name, ignoring case, or by
   * notebook id. With no name, the only board there is. Throws CallerError otherwise.
   */
  async entry(text: string | undefined): Promise<BoardEntry> {
    const boards = await this.list();
    if (text === undefined || text.trim() === '') {
      if (boards.length === 1) return boards[0]!;
      throw new CallerError(
        boards.length === 0 ? 'There are no boards yet. Make one on a notebook with create_board.' : `Say which board: ${describeBoards(boards)}.`,
      );
    }
    const wanted = text.trim().toLowerCase();
    const byKey = boards.filter((board) => board.key.toLowerCase() === wanted || board.notebookId === text.trim());
    const matches = byKey.length > 0 ? byKey : boards.filter((board) => board.name.toLowerCase() === wanted);
    if (matches.length > 1) {
      const listed = matches.map((board) => `${board.name} (key ${board.key}, notebook id ${board.notebookId})`).join(', ');
      throw new CallerError(`Several boards match "${text}": ${listed}. Give the notebook id.`);
    }
    if (matches.length === 0) throw new CallerError(`No board is called "${text}". The boards are: ${describeBoards(boards) || 'none yet'}.`);
    return matches[0]!;
  }

  /** The board as plain objects, with each card's title from its notebook. */
  async open(entry: BoardEntry): Promise<BoardSnapshot> {
    const notebook = await this.copyOf(notebookDocId(entry.notebookId));
    const board = await this.hub.withDoc(boardDocId(entry.notebookId), (doc) => readBoard(doc, notebook));
    notebook.destroy();
    return board;
  }

  /**
   * The card a caller named by ref (`DEE-12`), by its page id, or by its
   * page address. Archived cards and cards whose page is deleted are found
   * too. Throws CallerError otherwise.
   */
  async card(text: string): Promise<OpenCard> {
    const boards = await this.list();
    const ref = parseCardRef(text);
    const byKey = ref === null ? undefined : boards.find((board) => board.key === ref.key);
    if (ref !== null && byKey !== undefined) {
      const board = await this.open(byKey);
      const card = [...board.cards, ...board.hiddenCards].find((candidate) => candidate.number === ref.number);
      if (card !== undefined) return { entry: byKey, board, card, ref: formatCardRef(byKey.key, card.number) };
    }
    const pageId = pageIdOf(text);
    if (pageId !== null) {
      for (const entry of boards) {
        const board = await this.open(entry);
        const card = findCard(board, pageId);
        if (card !== null) return { entry, board, card, ref: formatCardRef(entry.key, card.number) };
      }
    }
    if (ref === null) {
      throw new CallerError(`"${text}" is not a card ref such as DEE-12, nor the page id or page address of a card. Find cards with search_cards.`);
    }
    if (byKey === undefined) throw new CallerError(`No board has the key ${ref.key}. The boards are: ${describeBoards(boards) || 'none yet'}.`);
    throw new CallerError(`${byKey.name} has no card ${formatCardRef(ref.key, ref.number)}. Find cards with search_cards.`);
  }

  /**
   * The page a caller named by a card ref, a page address or a page id. A
   * ref names its card's page, and throws CallerError when no card has it;
   * anything else is returned as the page id it holds, for the caller to look up.
   */
  async pageId(text: string): Promise<string> {
    if (parseCardRef(text) !== null) return (await this.card(text)).card.id;
    return pageIdOf(text) ?? text.trim();
  }

  /** Each page's To Do lines from the line index, for the given pages; a page with none is left out. */
  async checklists(pageIds: Iterable<string>): Promise<Map<string, readonly TodoLine[]>> {
    const index = await this.index.current();
    const found = new Map<string, readonly TodoLine[]>();
    for (const pageId of pageIds) {
      const lines = index.get(pageId);
      if (lines !== undefined) found.set(pageId, lines);
    }
    return found;
  }

  /** The board's Inbox lane, newest first. */
  async inbox(entry: BoardEntry, board: BoardSnapshot): Promise<InboxLine[]> {
    const pages = await this.hub.withDoc(notebookDocId(entry.notebookId), livePages);
    return inboxLines({ createdAt: board.meta.createdAt, lines: await this.index.current(), cardPageIds: cardPageIds(board), livePages: pages });
  }

  /**
   * The line in the board's Inbox with this id. Throws CallerError saying why
   * when the line is not in the Inbox: not on a live page of the notebook, on
   * a card's checklist, ticked, kept as a line, or tagged before the board.
   */
  async inboxLine(entry: BoardEntry, board: BoardSnapshot, lineId: string): Promise<InboxLine> {
    const found = (await this.inbox(entry, board)).find((line) => line.id === lineId);
    if (found !== undefined) return found;
    const pages = await this.hub.withDoc(notebookDocId(entry.notebookId), livePages);
    const cards = cardPageIds(board);
    for (const [pageId, lines] of await this.index.current()) {
      const line = lines.find((candidate) => candidate.id === lineId);
      if (line === undefined || !pages.has(pageId)) continue;
      const quoted = `The line "${line.text}"`;
      const instead = 'Make the card from a title instead, or choose a line from the Inbox in get_board.';
      if (cards.has(pageId)) {
        const card = findCard(board, pageId)!;
        throw new CallerError(`${quoted} is on the checklist of ${formatCardRef(entry.key, card.number)}, and a card's checklist lines stay on its page. ${instead}`);
      }
      if (line.checked) throw new CallerError(`${quoted} is ticked, so it is done and not in the Inbox. ${instead}`);
      if (!line.inbox) throw new CallerError(`Someone chose "Keep it as a line" for the line "${line.text}", so it stays out of the Inbox. ${instead}`);
      throw new CallerError(`${quoted} was tagged To Do before the board was made, so it is not in the Inbox. ${instead}`);
    }
    throw new CallerError(`No To Do line on a page of ${entry.name} has the id "${lineId}". get_board lists the Inbox lines with their ids.`);
  }

  /**
   * The live section of a notebook a caller named by id, by path
   * (`Group / Section`) or by name, ignoring case. Throws CallerError when
   * none matches or a name fits several.
   */
  async section(notebookId: string, text: string): Promise<{ id: string; path: string }> {
    const sections: Array<{ id: string; path: string }> = [];
    const visit = (children: TreeChild[], above: string[]): void => {
      for (const child of children) {
        const path = [...above, child.name];
        if (child.kind === 'group') visit(child.children, path);
        else sections.push({ id: child.id, path: path.join(' / ') });
      }
    };
    visit((await this.hub.withDoc(notebookDocId(notebookId), readTree)).children, []);
    const wanted = text.trim().toLowerCase();
    const byId = sections.find((section) => section.id === text.trim());
    if (byId !== undefined) return byId;
    const byPath = sections.filter((section) => section.path.toLowerCase() === wanted);
    const matches = byPath.length > 0 ? byPath : sections.filter((section) => section.path.split(' / ').at(-1)!.toLowerCase() === wanted);
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) {
      throw new CallerError(`Several sections are called "${text}": ${matches.map((section) => `${section.path} (section id: ${section.id})`).join(', ')}. Give the section id.`);
    }
    throw new CallerError(`The notebook has no section called "${text}". Its sections are: ${sections.map((section) => section.path).join(', ') || 'none yet'}.`);
  }

  /** A page's To Do lines read from its doc now, in reading order. */
  todoLines(pageId: string): Promise<TodoLine[]> {
    return this.hub.withDoc(pageDocId(pageId), listTodoLines);
  }

  /**
   * A page of the notebook as Markdown, read from its doc, without its title
   * and created lines. Pictures and files are links to asset file names. ''
   * when the notebook has no such page.
   */
  async pageMarkdown(notebookId: string, pageId: string): Promise<string> {
    const source = {
      getDoc: (docId: string) => this.copyOf(docId),
      // The bytes are not needed, only whether the server holds the blob, so the link is written.
      getBlob: async (hash: string) => ((await this.store.hasBlob(hash)) ? new Uint8Array() : null),
    };
    let files;
    try {
      files = await exportPage(source, notebookId, pageId, 'markdown');
    } catch {
      return '';
    }
    const text = new TextDecoder().decode(files[0]!.data);
    const afterTitle = text.indexOf('\n\n');
    const afterCreated = afterTitle === -1 ? -1 : text.indexOf('\n\n', afterTitle + 2);
    return afterCreated === -1 ? '' : text.slice(afterCreated + 2);
  }

  /** Each page's words, for a search by words, read from the store. */
  async pageTexts(pageIds: Iterable<string>): Promise<Map<string, string>> {
    const texts = new Map<string, string>();
    for (const pageId of pageIds) {
      const updates = await this.store.readUpdates(pageDocId(pageId));
      const doc = new Y.Doc();
      if (updates.length > 0) Y.applyUpdate(doc, Y.mergeUpdates(updates));
      texts.set(pageId, extractPageText(doc));
      doc.destroy();
    }
    return texts;
  }

  /** A copy of a doc as the hub holds it now, to read alongside another doc. */
  private async copyOf(docId: string): Promise<Y.Doc> {
    const update = await this.hub.withDoc(docId, (doc) => Y.encodeStateAsUpdate(doc));
    const copy = new Y.Doc();
    Y.applyUpdate(copy, update);
    return copy;
  }
}

/** The page id in a page address, or the text itself when it could be a page id; null otherwise. */
function pageIdOf(text: string): string | null {
  const trimmed = text.trim();
  const fromApp = pageIdFromAppAddress(trimmed);
  if (fromApp !== null) return fromApp;
  const hash = trimmed.indexOf('#');
  if (hash !== -1) return pageIdFromHash(trimmed.slice(hash));
  return /^[A-Za-z0-9_-]+$/.test(trimmed) ? trimmed : null;
}

function describeBoards(boards: readonly BoardEntry[]): string {
  return boards.map((board) => `${board.name} (${board.key})`).join(', ');
}

/**
 * The status a caller named by id, by name, or by kind (`todo`, `doing`,
 * `done`: the first status of that kind). Throws CallerError when the name
 * fits several statuses or none.
 */
export function resolveStatus(board: BoardSnapshot, text: string): Status {
  const wanted = text.trim().toLowerCase();
  const named = board.statuses.filter((status) => status.name.toLowerCase() === wanted);
  if (named.length > 1) {
    const listed = named.map((status) => `${status.name} (${status.kind}, id ${status.id})`).join(', ');
    throw new CallerError(`Several statuses are called "${text}": ${listed}. Give the status id.`);
  }
  const found =
    board.statuses.find((status) => status.id === text.trim()) ??
    named[0] ??
    board.statuses.find((status) => status.kind === wanted);
  if (found === undefined) {
    const names = board.statuses.map((status) => `${status.name} (${status.kind})`).join(', ');
    throw new CallerError(`No status is called "${text}". This board's statuses are: ${names || 'none yet'}.`);
  }
  return found;
}

/** The label a caller named by id or by name. Throws CallerError when the name fits several labels or none. */
export function resolveLabel(board: BoardSnapshot, text: string): Label {
  const wanted = text.trim().toLowerCase();
  const byId = board.labels.find((label) => label.id === text.trim());
  if (byId !== undefined) return byId;
  const named = board.labels.filter((label) => label.name.toLowerCase() === wanted);
  if (named.length > 1) {
    const listed = named.map((label) => `${label.name} (${label.color}, id ${label.id})`).join(', ');
    throw new CallerError(`Several labels are called "${text}": ${listed}. Give the label id.`);
  }
  const found = named[0];
  if (found === undefined) {
    const names = board.labels.map((label) => label.name).join(', ');
    throw new CallerError(`No label is called "${text}". This board's labels are: ${names || 'none yet'}. Add one with create_label.`);
  }
  return found;
}

/** `DEE-12 "Title"`, the way a tool names the card it changed. */
export function nameCard(key: string, card: { number: number; title: string }): string {
  return `${formatCardRef(key, card.number)} "${card.title || 'Untitled page'}"`;
}

/**
 * A day a caller wrote, as stored: `YYYY-MM-DD`, or null for "none" or an
 * empty text. Throws CallerError for anything else, days that do not exist
 * included.
 */
export function dueDay(text: string): string | null {
  const trimmed = text.trim().toLowerCase();
  if (trimmed === '' || trimmed === 'none') return null;
  const time = /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? Date.parse(`${trimmed}T00:00:00Z`) : NaN;
  if (Number.isNaN(time) || new Date(time).toISOString().slice(0, 10) !== trimmed) {
    throw new CallerError(`"${text}" is not a day. Write a day as YYYY-MM-DD, or "none" for no day.`);
  }
  return trimmed;
}
