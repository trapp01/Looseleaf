/**
 * Where a dragged card is while it moves, and where it lands. During a drag
 * the board shows `Columns`, a copy of each status's card ids that moves the
 * dragged card as it crosses statuses; the drop reads the card's final place
 * out of it. Nothing here touches the doc.
 */

/** Status id → the ids of the cards showing in it, top first. */
export type Columns = Record<string, string[]>;

/** The status holding the card, or null. */
export function columnOf(columns: Columns, cardId: string): string | null {
  for (const [statusId, ids] of Object.entries(columns)) if (ids.includes(cardId)) return statusId;
  return null;
}

/**
 * The columns with the card moved to `index` in `statusId` (clamped to the
 * column's length, counted without the card). The same object comes back when
 * nothing changes, so a drag-over that lands where the card already is does
 * not re-render.
 */
export function placeCard(columns: Columns, cardId: string, statusId: string, index: number): Columns {
  const from = columnOf(columns, cardId);
  if (from === null || !(statusId in columns)) return columns;
  const without = columns[statusId]!.filter((id) => id !== cardId);
  const at = Math.max(0, Math.min(index, without.length));
  if (from === statusId && columns[statusId]!.indexOf(cardId) === at) return columns;
  const next: Columns = { ...columns, [from]: columns[from]!.filter((id) => id !== cardId) };
  next[statusId] = [...without.slice(0, at), cardId, ...without.slice(at)];
  return next;
}

/** What the dragged card is over: another card (and whether the pointer is past its middle), or a status's empty space. */
export type DragOver = { kind: 'card'; cardId: string; below: boolean } | { kind: 'status'; statusId: string };

/**
 * The columns after the dragged card passes over `over`. Over another card in
 * the same status the card takes that card's place (sortable order); over a
 * card in another status it goes before or after it by the pointer; over a
 * status's empty space it goes to the bottom.
 */
export function dragOver(columns: Columns, cardId: string, over: DragOver): Columns {
  if (over.kind === 'status') {
    if (columnOf(columns, cardId) === over.statusId) return columns;
    return placeCard(columns, cardId, over.statusId, Infinity);
  }
  if (over.cardId === cardId) return columns;
  const target = columnOf(columns, over.cardId);
  if (target === null) return columns;
  const ids = columns[target]!;
  const overIndex = ids.indexOf(over.cardId);
  if (columnOf(columns, cardId) === target) return placeCard(columns, cardId, target, overIndex);
  return placeCard(columns, cardId, target, overIndex + (over.below ? 1 : 0));
}

/**
 * Where the card lands: its status and its index among the other cards showing
 * there, which is what model's `moveCard` takes as `place`. Null when the card
 * is in no column.
 */
export function dropPlace(columns: Columns, cardId: string): { statusId: string; index: number } | null {
  const statusId = columnOf(columns, cardId);
  if (statusId === null) return null;
  return { statusId, index: columns[statusId]!.indexOf(cardId) };
}

/** True when the drop leaves the card where it started, so no write is needed. */
export function samePlace(before: Columns, after: Columns, cardId: string): boolean {
  const a = dropPlace(before, cardId);
  const b = dropPlace(after, cardId);
  return a !== null && b !== null && a.statusId === b.statusId && a.index === b.index;
}

/**
 * Where an Inbox line dragged over `over` would become a card: before or
 * after the card under it by the pointer, or at the bottom of a status's
 * empty space. The index counts the cards showing in that status. Null when
 * `over` is not on the board's statuses.
 */
export function lineDropPlace(columns: Columns, over: DragOver): { statusId: string; index: number } | null {
  if (over.kind === 'status') return over.statusId in columns ? { statusId: over.statusId, index: columns[over.statusId]!.length } : null;
  const statusId = columnOf(columns, over.cardId);
  if (statusId === null) return null;
  return { statusId, index: columns[statusId]!.indexOf(over.cardId) + (over.below ? 1 : 0) };
}
