/**
 * Writing cards in a board doc: putting a page on the board, moving and
 * archiving its card, and the due day, labels, comments and links on it. A
 * card is keyed by its page id. Every writer takes the board doc and makes
 * its change in one transaction; `by` is the actor recorded in the card's
 * activity. Writers that also touch the notebook or a page are in filing.ts
 * and promote.ts.
 */
import type * as Y from 'yjs';
import { newId } from '../ids.js';
import { orderAt, sortByOrder } from '../order.js';
import { activityArray, cardsMap, fieldKey, fieldValue, MADE, readRow, readRows, readStatuses, type Activity, type Status } from './board.js';

/** Where a card goes in a status: the top, the bottom, or a position counted from the top. */
export type CardPlace = 'top' | 'bottom' | number;

/** The card's number, or null when the page is not a card on this board. */
export function cardNumber(doc: Y.Doc, pageId: string): number | null {
  const number = getField(doc, pageId, 'number');
  return number === undefined ? null : Number(number);
}

function requireCard(doc: Y.Doc, pageId: string): void {
  if (cardNumber(doc, pageId) === null) throw new Error(`Page "${pageId}" is not a card on this board`);
}

/** A card field's latest change, else the value the card was made with; undefined when it has neither. */
function getField(doc: Y.Doc, pageId: string, field: string): unknown {
  const cards = cardsMap(doc);
  const key = fieldKey(pageId, field);
  return cards.has(key) ? cards.get(key) : cards.get(fieldKey(pageId, MADE, field));
}

function setField(doc: Y.Doc, pageId: string, field: string, value: unknown): void {
  cardsMap(doc).set(fieldKey(pageId, field), value);
}

/** Writes a value the card is made with; any change to the field outweighs it. */
function setMade(doc: Y.Doc, pageId: string, field: string, value: unknown): void {
  cardsMap(doc).set(fieldKey(pageId, MADE, field), value);
}

function touch(doc: Y.Doc, pageId: string, now = Date.now()): void {
  setField(doc, pageId, 'updatedAt', now);
}

function log(doc: Y.Doc, pageId: string, entry: Activity): void {
  activityArray(doc).push([{ ...entry, card: pageId }]);
}

/** The ids of the labels on a card, in the order they were put on. */
export function cardLabelIds(doc: Y.Doc, pageId: string): string[] {
  return [...(readRow(cardsMap(doc), pageId).entries.get('label')?.keys() ?? [])];
}

/** The number a new card on this board takes: one past the highest in use. */
export function nextCardNumber(doc: Y.Doc): number {
  let highest = 0;
  for (const row of readRows(cardsMap(doc)).values()) highest = Math.max(highest, Number(fieldValue(row, 'number') ?? 0));
  return highest + 1;
}

/**
 * The cards in a status that are not archived, top first, without `except`.
 * Cards whose page is deleted count too, since the board doc alone cannot
 * tell them apart.
 */
function siblingsIn(doc: Y.Doc, statusId: string, except?: string): Array<{ id: string; order: string }> {
  const siblings: Array<{ id: string; order: string }> = [];
  for (const [id, row] of readRows(cardsMap(doc))) {
    const value = (field: string) => fieldValue(row, field);
    if (id === except || value('number') === undefined || value('status') !== statusId || value('archivedAt') != null) continue;
    siblings.push({ id, order: String(value('order') ?? '') });
  }
  return sortByOrder(siblings);
}

function placeIndex(place: CardPlace | undefined, count: number): number {
  if (place === undefined || place === 'bottom') return count;
  if (place === 'top') return 0;
  return Math.max(0, Math.min(place, count));
}

function statusFor(doc: Y.Doc, statusId: string | undefined): Status {
  const { statuses, archivedStatuses } = readStatuses(doc);
  if (statusId === undefined) {
    const first = statuses.find((status) => status.kind === 'todo') ?? statuses[0];
    if (first === undefined) throw new Error('The board has no statuses to put a card in');
    return first;
  }
  const found = [...statuses, ...archivedStatuses].find((status) => status.id === statusId);
  if (found === undefined) throw new Error(`No status has the id "${statusId}"`);
  return found;
}

export interface PutOnBoard {
  /** The board's first `todo` status when left out. */
  statusId?: string;
  /** The top of the status when left out. */
  place?: CardPlace;
  labelIds?: string[];
  due?: string | null;
  links?: Array<{ target: string; title: string }>;
  by: string;
  now?: number;
}

/**
 * Makes a page a card: in the given status (the first `todo` status when left
 * out), at the top unless placed, with the next number. A page that is
 * already a card keeps its card, ref and history; an archived one is
 * restored. Two replicas that put the same page on the board while apart end
 * with one card holding what each put on it. Returns the card's number.
 * Throws when the status does not exist or the board has none.
 */
export function putOnBoard(doc: Y.Doc, pageId: string, input: PutOnBoard): number {
  const existing = cardNumber(doc, pageId);
  if (existing !== null) {
    restoreCard(doc, pageId, input.by);
    return existing;
  }
  const status = statusFor(doc, input.statusId);
  const siblings = siblingsIn(doc, status.id);
  const now = input.now ?? Date.now();
  const number = nextCardNumber(doc);
  const cards = cardsMap(doc);
  doc.transact(() => {
    setMade(doc, pageId, 'number', number);
    setMade(doc, pageId, 'status', status.id);
    setMade(doc, pageId, 'order', orderAt(siblings, placeIndex(input.place ?? 'top', siblings.length)));
    setMade(doc, pageId, 'createdAt', now);
    setMade(doc, pageId, 'createdBy', input.by);
    setMade(doc, pageId, 'updatedAt', now);
    if (input.due != null) setMade(doc, pageId, 'due', input.due);
    for (const labelId of input.labelIds ?? []) cards.set(fieldKey(pageId, 'label', labelId), true);
    // Ids from the link's place, so two replicas that make the same card make each of its first links once.
    (input.links ?? []).forEach((link, index) => {
      cards.set(fieldKey(pageId, 'link', `first-${index + 1}`), { target: link.target, title: link.title, at: now });
    });
    log(doc, pageId, { type: 'created', at: now, by: input.by, status: status.name });
  });
  return number;
}

/** Sets or clears (`null`) a card's due day, `YYYY-MM-DD`. */
export function setCardDue(doc: Y.Doc, pageId: string, due: string | null): void {
  requireCard(doc, pageId);
  doc.transact(() => {
    setField(doc, pageId, 'due', due);
    touch(doc, pageId);
  });
}

/**
 * Puts a label on a card or takes it off, in the board doc only. Callers use
 * `labelCard` in filing.ts, which also files the page on its first tied label.
 */
export function setCardLabel(doc: Y.Doc, pageId: string, labelId: string, on: boolean): void {
  requireCard(doc, pageId);
  doc.transact(() => {
    if (on) cardsMap(doc).set(fieldKey(pageId, 'label', labelId), true);
    else cardsMap(doc).delete(fieldKey(pageId, 'label', labelId));
    touch(doc, pageId);
  });
}

/**
 * Moves a card to a place in a status, counted among the status's other cards
 * that are not archived. A move to another status is recorded in the card's
 * activity; a reorder inside one status is not.
 */
export function moveCard(doc: Y.Doc, pageId: string, to: { statusId: string; place?: CardPlace }, by: string): void {
  requireCard(doc, pageId);
  const target = statusFor(doc, to.statusId);
  const siblings = siblingsIn(doc, target.id, pageId);
  const fromId = String(getField(doc, pageId, 'status') ?? '');
  const { statuses, archivedStatuses } = readStatuses(doc);
  const from = [...statuses, ...archivedStatuses].find((status) => status.id === fromId);
  doc.transact(() => {
    setField(doc, pageId, 'order', orderAt(siblings, placeIndex(to.place, siblings.length)));
    if (fromId !== target.id) {
      setField(doc, pageId, 'status', target.id);
      log(doc, pageId, { type: 'moved', at: Date.now(), by, from: from?.name ?? '', to: target.name });
    }
    touch(doc, pageId);
  });
}

/**
 * Takes a card off the board. Its page stays where it is as a loose page, and
 * `restoreCard` brings back the same ref and history. Archiving an archived
 * card does nothing.
 */
export function archiveCard(doc: Y.Doc, pageId: string, by: string): void {
  requireCard(doc, pageId);
  if (getField(doc, pageId, 'archivedAt') != null) return;
  doc.transact(() => {
    const now = Date.now();
    setField(doc, pageId, 'archivedAt', now);
    log(doc, pageId, { type: 'archived', at: now, by });
    touch(doc, pageId, now);
  });
}

/** Puts an archived card back where it was. Restoring a card that is not archived does nothing. */
export function restoreCard(doc: Y.Doc, pageId: string, by: string): void {
  requireCard(doc, pageId);
  if (getField(doc, pageId, 'archivedAt') == null) return;
  doc.transact(() => {
    const now = Date.now();
    setField(doc, pageId, 'archivedAt', null);
    log(doc, pageId, { type: 'restored', at: now, by });
    touch(doc, pageId, now);
  });
}

interface StoredComment {
  body: string;
  by: string;
  at: number;
  editedAt: number | null;
}

/** Adds a comment and returns its id. */
export function addComment(doc: Y.Doc, pageId: string, body: string, by: string): string {
  requireCard(doc, pageId);
  const id = newId();
  doc.transact(() => {
    const comment: StoredComment = { body, by, at: Date.now(), editedAt: null };
    cardsMap(doc).set(fieldKey(pageId, 'comment', id), comment);
    touch(doc, pageId);
  });
  return id;
}

export function editComment(doc: Y.Doc, pageId: string, commentId: string, body: string): void {
  requireCard(doc, pageId);
  const key = fieldKey(pageId, 'comment', commentId);
  const comment = cardsMap(doc).get(key) as StoredComment | undefined;
  if (comment === undefined || cardsMap(doc).has(fieldKey(pageId, 'deletedComment', commentId))) {
    throw new Error(`The card has no comment with the id "${commentId}"`);
  }
  cardsMap(doc).set(key, { ...comment, body, editedAt: Date.now() });
}

/**
 * Removes a comment's text and marks it deleted. The mark keeps it deleted
 * when another replica edits it at the same time; `clearDeletedComments`
 * removes the text such an edit brings back. Deleting a comment already gone
 * does nothing.
 */
export function deleteComment(doc: Y.Doc, pageId: string, commentId: string): void {
  requireCard(doc, pageId);
  doc.transact(() => {
    cardsMap(doc).set(fieldKey(pageId, 'deletedComment', commentId), true);
    cardsMap(doc).delete(fieldKey(pageId, 'comment', commentId));
  });
}

/**
 * Removes the text of every comment marked deleted that an edit made at the
 * same time as the deletion brought back. Any replica may run it; servers run
 * it after every change they store to a board doc. Returns how many it removed.
 */
export function clearDeletedComments(doc: Y.Doc): number {
  const cards = cardsMap(doc);
  const stale: string[] = [];
  for (const [pageId, row] of readRows(cards)) {
    row.entries.get('deletedComment')?.forEach((_, commentId) => {
      if (row.entries.get('comment')?.has(commentId)) stale.push(fieldKey(pageId, 'comment', commentId));
    });
  }
  if (stale.length > 0) doc.transact(() => stale.forEach((key) => cards.delete(key)));
  return stale.length;
}

/** Adds a link and returns its id. A card that already links to the target keeps its one link, with the new title. */
export function addLink(doc: Y.Doc, pageId: string, link: { target: string; title: string }): string {
  requireCard(doc, pageId);
  let id = newId();
  let at = Date.now();
  readRow(cardsMap(doc), pageId).entries.get('link')?.forEach((value, existingId) => {
    const existing = value as { target: string; at: number };
    if (existing.target !== link.target) return;
    id = existingId;
    at = existing.at;
  });
  doc.transact(() => {
    cardsMap(doc).set(fieldKey(pageId, 'link', id), { target: link.target, title: link.title, at });
    touch(doc, pageId);
  });
  return id;
}

/** Removing a link already gone does nothing. */
export function removeLink(doc: Y.Doc, pageId: string, linkId: string): void {
  requireCard(doc, pageId);
  cardsMap(doc).delete(fieldKey(pageId, 'link', linkId));
}

/**
 * Gives every card on the board a number of its own. Two replicas that each
 * added a card while apart both take the next number; the card created first
 * keeps it and the others take the numbers after the highest. Returns how
 * many numbers changed. Only servers run this, so two replicas never
 * renumber in different directions.
 */
export function renumberDuplicateCards(doc: Y.Doc): number {
  const cards: Array<{ id: string; number: number; createdAt: number }> = [];
  for (const [id, row] of readRows(cardsMap(doc))) {
    const number = fieldValue(row, 'number');
    if (number !== undefined) cards.push({ id, number: Number(number), createdAt: Number(fieldValue(row, 'createdAt') ?? 0) });
  }
  cards.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
  const seen = new Set<number>();
  const clashing = cards.filter((card) => {
    if (card.number >= 1 && !seen.has(card.number)) {
      seen.add(card.number);
      return false;
    }
    return true;
  });
  if (clashing.length === 0) return 0;
  let next = Math.max(0, ...seen) + 1;
  doc.transact(() => {
    for (const card of clashing) setField(doc, card.id, 'number', next++);
  });
  return clashing.length;
}
