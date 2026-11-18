/**
 * A board doc (`board:<notebookId>`) read as plain objects. `readBoard` is the
 * one reader: the web client, the search and the Markdown renderers all work
 * from its result and never touch the Yjs types. A card is a page, so the
 * reader takes the notebook doc too, for each card's title and to tell which
 * cards' pages are live. The writers are in keys.ts (the board itself),
 * statuses.ts (statuses and labels) and cards.ts (cards).
 */
import * as Y from 'yjs';
import { livePages, getNode } from '../notebook.js';
import { sortByOrder } from '../order.js';
import type { TodoLine } from '../todo-lines.js';
import { labelColorOr, type LabelColor } from './colors.js';

/**
 * What a status means for the work on its cards, whatever the status is
 * called: not started, being worked on, or finished.
 */
export type StatusKind = 'todo' | 'doing' | 'done';

export const STATUS_KINDS: readonly StatusKind[] = ['todo', 'doing', 'done'];

/** The board's own fields, from the doc's `meta` map. */
export interface BoardMeta {
  /** The prefix of the board's card refs, e.g. `DEE` in `DEE-12`. Uppercase letters and digits. */
  key: string;
  /** Epoch ms. Only To Do lines tagged after this reach the Inbox. */
  createdAt: number;
  /** The id of the Unfiled section once it has been made, else null. */
  unfiledSection: string | null;
}

export interface Status {
  id: string;
  name: string;
  kind: StatusKind;
  order: string;
  archivedAt: number | null;
}

export interface Label {
  id: string;
  name: string;
  color: LabelColor;
  order: string;
  /** The label tie: the section new cards with this label are filed in, or null. */
  section: string | null;
}

export interface Comment {
  id: string;
  /** Markdown. */
  body: string;
  /** The actor who wrote it. */
  by: string;
  at: number;
  editedAt: number | null;
}

/** A pointer from a card to something outside the board. */
export interface Link {
  id: string;
  /** A URL, or `looseleaf:<pageId>` for a page; see refs.ts. */
  target: string;
  title: string;
  at: number;
}

/** One entry in a card's history. Status names are copied in, so the entry still reads after a rename. */
export type Activity =
  | { type: 'created'; at: number; by: string; status: string }
  | { type: 'moved'; at: number; by: string; from: string; to: string }
  | { type: 'archived'; at: number; by: string }
  | { type: 'restored'; at: number; by: string };

export interface Card {
  /** The card's page id. A card has no id of its own. */
  id: string;
  /** The number in the card's ref. Unique on its board once a server has seen the card. */
  number: number;
  /** The page title, from the notebook doc; '' when the notebook no longer has the page. */
  title: string;
  /** The section holding the page; null when the page is not live in the board's notebook. */
  sectionId: string | null;
  statusId: string;
  order: string;
  labelIds: string[];
  /** A calendar day, `YYYY-MM-DD`, or null. */
  due: string | null;
  comments: Comment[];
  links: Link[];
  activity: Activity[];
  createdAt: number;
  createdBy: string;
  updatedAt: number;
  archivedAt: number | null;
}

export interface BoardSnapshot {
  meta: BoardMeta;
  /** Statuses that are not archived, in board order. */
  statuses: Status[];
  archivedStatuses: Status[];
  /** In label order. */
  labels: Label[];
  /** Cards whose page is live in the board's notebook, archived ones included, in no particular order. */
  cards: Card[];
  /** Cards whose page is deleted, gone, or in another notebook. They show again when the page is restored. */
  hiddenCards: Card[];
}

export function metaMap(doc: Y.Doc): Y.Map<unknown> {
  return doc.getMap('meta');
}

/**
 * The `statuses` and `cards` maps hold one entry per field. The values a
 * status or card is made with are keyed `<id>/made/<field>`; a later change
 * to a field is keyed `<id>/<field>` and outweighs the made value. A card's
 * labels, comments and links are keyed `<id>/<field>/<entryId>`, and a
 * deleted comment is marked `<id>/deletedComment/<commentId>`. Two replicas
 * that make the same status or card while apart therefore merge field by
 * field, and neither loses what the other then changed or put on it.
 */
export function statusesMap(doc: Y.Doc): Y.Map<unknown> {
  return doc.getMap('statuses');
}

export function labelsMap(doc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return doc.getMap('labels');
}

/** See `statusesMap` for the key layout. */
export function cardsMap(doc: Y.Doc): Y.Map<unknown> {
  return doc.getMap('cards');
}

/** An activity entry as stored in the board's one `activity` array: the entry and its card's page id. */
export type StoredActivity = Activity & { card: string };

/** Every card's history, oldest first within a card. */
export function activityArray(doc: Y.Doc): Y.Array<StoredActivity> {
  return doc.getArray('activity');
}

/** The key of one field of a status or card, or of one entry (`entryId`) under a card's field. Throws for an id holding "/". */
export function fieldKey(id: string, field: string, entryId?: string): string {
  if (id.includes('/')) throw new Error(`"${id}" cannot name a status or card: ids on a board hold no "/"`);
  return entryId === undefined ? `${id}/${field}` : `${id}/${field}/${entryId}`;
}

/** The entry field holding the values a status or card was made with. */
export const MADE = 'made';

/** One status or card read from its map: its fields, and its entries by field and entry id. */
export interface FieldRow {
  fields: Map<string, unknown>;
  entries: Map<string, Map<string, unknown>>;
}

function addToRow(row: FieldRow, rest: string, value: unknown): void {
  const slash = rest.indexOf('/');
  if (slash < 0) {
    row.fields.set(rest, value);
    return;
  }
  const field = rest.slice(0, slash);
  let entries = row.entries.get(field);
  if (entries === undefined) row.entries.set(field, (entries = new Map()));
  entries.set(rest.slice(slash + 1), value);
}

/** Every status or card in `map`, by id, in one pass. */
export function readRows(map: Y.Map<unknown>): Map<string, FieldRow> {
  const rows = new Map<string, FieldRow>();
  map.forEach((value, key) => {
    const slash = key.indexOf('/');
    if (slash < 0) return;
    const id = key.slice(0, slash);
    let row = rows.get(id);
    if (row === undefined) rows.set(id, (row = { fields: new Map(), entries: new Map() }));
    addToRow(row, key.slice(slash + 1), value);
  });
  return rows;
}

/** One status or card in `map`; empty when there is none with this id. */
export function readRow(map: Y.Map<unknown>, id: string): FieldRow {
  const row: FieldRow = { fields: new Map(), entries: new Map() };
  const prefix = `${id}/`;
  map.forEach((value, key) => {
    if (key.startsWith(prefix)) addToRow(row, key.slice(prefix.length), value);
  });
  return row;
}

/** A field of a status or card: its latest change, else the value it was made with. */
export function fieldValue(row: FieldRow, field: string): unknown {
  return row.fields.has(field) ? row.fields.get(field) : row.entries.get(MADE)?.get(field);
}

/** The board's own fields, or null when the doc holds no board (no key has been set). */
export function readBoardMeta(doc: Y.Doc): BoardMeta | null {
  const meta = metaMap(doc);
  const key = meta.get('key');
  if (typeof key !== 'string' || key === '') return null;
  const unfiled = meta.get('unfiledSection');
  return { key, createdAt: Number(meta.get('createdAt') ?? 0), unfiledSection: typeof unfiled === 'string' ? unfiled : null };
}

function readStatus(id: string, row: FieldRow): Status {
  const kind = fieldValue(row, 'kind');
  return {
    id,
    name: String(fieldValue(row, 'name') ?? ''),
    kind: STATUS_KINDS.includes(kind as StatusKind) ? (kind as StatusKind) : 'todo',
    order: String(fieldValue(row, 'order') ?? ''),
    archivedAt: (fieldValue(row, 'archivedAt') as number | null | undefined) ?? null,
  };
}

function readLabel(id: string, map: Y.Map<unknown>): Label {
  const section = map.get('section');
  return {
    id,
    name: String(map.get('name') ?? ''),
    color: labelColorOr(map.get('color')),
    order: String(map.get('order') ?? ''),
    section: typeof section === 'string' ? section : null,
  };
}

/** A card's comments or links as plain objects carrying their id, oldest first, leaving out those marked under `deletedField`. */
function readEntries<T extends { id: string; at: number }>(row: FieldRow, field: string, deletedField?: string): T[] {
  const entries: T[] = [];
  const deleted = deletedField === undefined ? undefined : row.entries.get(deletedField);
  row.entries.get(field)?.forEach((value, id) => {
    if (typeof value === 'object' && value !== null && !deleted?.has(id)) entries.push({ ...(value as object), id } as T);
  });
  return entries.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));
}

/** Every card's activity by page id, each oldest first. */
function readActivity(doc: Y.Doc): Map<string, Activity[]> {
  const byCard = new Map<string, Activity[]>();
  for (const { card, ...entry } of activityArray(doc).toArray()) {
    let list = byCard.get(card);
    if (list === undefined) byCard.set(card, (list = []));
    list.push(entry as Activity);
  }
  return byCard;
}

function readCard(id: string, row: FieldRow, activity: Activity[], page: { title: string; sectionId: string | null }): Card {
  const value = (field: string) => fieldValue(row, field);
  return {
    id,
    number: Number(value('number') ?? 0),
    title: page.title,
    sectionId: page.sectionId,
    statusId: String(value('status') ?? ''),
    order: String(value('order') ?? ''),
    labelIds: [...(row.entries.get('label')?.keys() ?? [])],
    due: (value('due') as string | null | undefined) ?? null,
    comments: readEntries<Comment>(row, 'comment', 'deletedComment'),
    links: readEntries<Link>(row, 'link'),
    activity,
    createdAt: Number(value('createdAt') ?? 0),
    createdBy: String(value('createdBy') ?? ''),
    updatedAt: Number(value('updatedAt') ?? 0),
    archivedAt: (value('archivedAt') as number | null | undefined) ?? null,
  };
}

/**
 * The whole board as plain objects. `notebook` is the doc of the notebook the
 * board belongs to: a card whose page that notebook shows takes the page's
 * title and section and is in `cards`; any other card is in `hiddenCards`.
 * A doc with no board reads as a board with an empty key and nothing on it.
 */
export function readBoard(board: Y.Doc, notebook: Y.Doc): BoardSnapshot {
  const pages = livePages(notebook);
  const activity = readActivity(board);
  const cards: Card[] = [];
  const hiddenCards: Card[] = [];
  for (const [id, row] of readRows(cardsMap(board))) {
    if (fieldValue(row, 'number') === undefined) continue;
    const page = pages.get(id);
    const card = readCard(id, row, activity.get(id) ?? [], page ?? { title: getNode(notebook, id)?.name ?? '', sectionId: null });
    (page === undefined ? hiddenCards : cards).push(card);
  }
  return {
    meta: readBoardMeta(board) ?? { key: '', createdAt: 0, unfiledSection: null },
    ...readStatuses(board),
    labels: readLabels(board),
    cards,
    hiddenCards,
  };
}

/** The board's statuses in board order, split into those showing and those archived. */
export function readStatuses(board: Y.Doc): { statuses: Status[]; archivedStatuses: Status[] } {
  const statuses: Status[] = [];
  for (const [id, row] of readRows(statusesMap(board))) {
    if (fieldValue(row, 'kind') !== undefined) statuses.push(readStatus(id, row));
  }
  const sorted = sortByOrder(statuses);
  return {
    statuses: sorted.filter((status) => status.archivedAt === null),
    archivedStatuses: sorted.filter((status) => status.archivedAt !== null),
  };
}

/** The board's labels in label order. */
export function readLabels(board: Y.Doc): Label[] {
  const labels: Label[] = [];
  labelsMap(board).forEach((map, id) => labels.push(readLabel(id, map)));
  return sortByOrder(labels);
}

/**
 * The status a card shows under: its own, or the board's first status when
 * its own was never synced to this replica. Null when the card's status is
 * archived (the card is hidden with it) or the board has no statuses.
 */
export function shownStatusId(board: BoardSnapshot, card: Card): string | null {
  if (board.statuses.some((status) => status.id === card.statusId)) return card.statusId;
  if (board.archivedStatuses.some((status) => status.id === card.statusId)) return null;
  return board.statuses[0]?.id ?? null;
}

/** The cards showing in a status, top first. Archived cards are left out. */
export function cardsInStatus(board: BoardSnapshot, statusId: string): Card[] {
  return sortByOrder(board.cards.filter((card) => card.archivedAt === null && shownStatusId(board, card) === statusId));
}

/** Every card showing on the board: not archived, and not in an archived status. */
export function shownCards(board: BoardSnapshot): Card[] {
  return board.cards.filter((card) => card.archivedAt === null && shownStatusId(board, card) !== null);
}

/** Cards that are archived themselves or sit in an archived status, most recently archived first. */
export function archivedCards(board: BoardSnapshot): Card[] {
  return board.cards
    .filter((card) => card.archivedAt !== null || shownStatusId(board, card) === null)
    .sort((a, b) => (b.archivedAt ?? b.updatedAt) - (a.archivedAt ?? a.updatedAt));
}

export function findStatus(board: BoardSnapshot, statusId: string): Status | null {
  return [...board.statuses, ...board.archivedStatuses].find((status) => status.id === statusId) ?? null;
}

/** The card for a page, live or hidden, or null when the page is not a card on this board. */
export function findCard(board: BoardSnapshot, pageId: string): Card | null {
  return board.cards.find((card) => card.id === pageId) ?? board.hiddenCards.find((card) => card.id === pageId) ?? null;
}

/** A card's labels in label order, skipping ids whose label was deleted. */
export function cardLabels(board: BoardSnapshot, card: Card): Label[] {
  return board.labels.filter((label) => card.labelIds.includes(label.id));
}

/**
 * The pages that are cards for the Inbox's "is not a card" test: every card
 * not archived, including those in an archived status. An archived card's
 * page is a loose page again.
 */
export function cardPageIds(board: BoardSnapshot): Set<string> {
  return new Set(board.cards.filter((card) => card.archivedAt === null).map((card) => card.id));
}

/** How many of a card's checklist items (the To Do lines on its page) are ticked, and how many there are. */
export function checklistProgress(lines: readonly TodoLine[]): { done: number; total: number } {
  return { done: lines.filter((line) => line.checked).length, total: lines.length };
}
