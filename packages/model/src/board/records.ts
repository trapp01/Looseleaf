/**
 * Writing a board and its cards from records made elsewhere, field for field:
 * the ids, numbers, orders, times and history given are stored as they are,
 * so refs and history survive a move from another program. An import uses
 * these; every other change to a board goes through keys.ts, statuses.ts and
 * cards.ts.
 */
import * as Y from 'yjs';
import { activityArray, cardsMap, fieldKey, labelsMap, MADE, metaMap, readBoardMeta, type Activity, type Comment, type Label, type Link, type Status } from './board.js';
import { cardNumber } from './cards.js';
import { normalizeBoardKey } from './keys.js';
import { writeNewStatus } from './statuses.js';

export interface BoardRecord {
  /** Stored as given; it must already be a normalized key. */
  key: string;
  createdAt: number;
  /** Every status, archived ones included. */
  statuses: readonly Status[];
  labels: readonly Label[];
}

/** A card's board fields as stored. The page id keys the card, so it is not part of the record. */
export interface CardRecord {
  number: number;
  statusId: string;
  order: string;
  labelIds: readonly string[];
  due: string | null;
  comments: readonly Comment[];
  links: readonly Link[];
  /** Oldest first, each entry stored as given. */
  activity: readonly Activity[];
  createdAt: number;
  createdBy: string;
  updatedAt: number;
  archivedAt: number | null;
}

/**
 * Makes the board on an empty board doc with exactly the given key, created
 * time, statuses and labels, and no Unfiled section yet. Throws when the doc
 * already holds a board or the key is not a normalized board key.
 */
export function writeBoardRecord(doc: Y.Doc, record: BoardRecord): void {
  const existing = readBoardMeta(doc);
  if (existing !== null) throw new Error(`This notebook already has a board, with the key ${existing.key}`);
  if (record.key === '' || normalizeBoardKey(record.key) !== record.key) throw new Error(`"${record.key}" is not a board key`);
  doc.transact(() => {
    const meta = metaMap(doc);
    meta.set('key', record.key);
    meta.set('createdAt', record.createdAt);
    meta.set('unfiledSection', null);
    for (const status of record.statuses) writeNewStatus(doc, status);
    for (const label of record.labels) {
      const map = new Y.Map<unknown>();
      map.set('name', label.name);
      map.set('color', label.color);
      map.set('order', label.order);
      map.set('section', label.section);
      labelsMap(doc).set(label.id, map);
    }
  });
}

/**
 * Puts a page on the board with exactly the given record: its number, place,
 * times, comment and link ids and activity are stored as they are and no
 * activity is added. Throws when the page is already a card on this board.
 */
export function writeCardRecord(doc: Y.Doc, pageId: string, record: CardRecord): void {
  if (cardNumber(doc, pageId) !== null) throw new Error(`Page "${pageId}" is already a card on this board`);
  const cards = cardsMap(doc);
  const set = (field: string, value: unknown) => cards.set(fieldKey(pageId, MADE, field), value);
  doc.transact(() => {
    set('number', record.number);
    set('status', record.statusId);
    set('order', record.order);
    if (record.due !== null) set('due', record.due);
    for (const labelId of record.labelIds) cards.set(fieldKey(pageId, 'label', labelId), true);
    for (const { id, ...comment } of record.comments) cards.set(fieldKey(pageId, 'comment', id), comment);
    for (const { id, ...link } of record.links) cards.set(fieldKey(pageId, 'link', id), link);
    activityArray(doc).push(record.activity.map((entry) => ({ ...entry, card: pageId })));
    set('createdAt', record.createdAt);
    set('createdBy', record.createdBy);
    set('updatedAt', record.updatedAt);
    if (record.archivedAt !== null) cards.set(fieldKey(pageId, 'archivedAt'), record.archivedAt);
  });
}
