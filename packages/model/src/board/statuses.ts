/** Writing a board's statuses (its columns) and labels, each in one transaction. */
import * as Y from 'yjs';
import { newId } from '../ids.js';
import { orderAt } from '../order.js';
import { fieldKey, labelsMap, MADE, readLabels, readStatuses, statusesMap, type Label, type Status, type StatusKind } from './board.js';
import { leastUsedLabelColor, type LabelColor } from './colors.js';

/** The statuses a new board starts with. */
export const DEFAULT_STATUSES: ReadonlyArray<{ name: string; kind: StatusKind }> = [
  { name: 'Backlog', kind: 'todo' },
  { name: 'This week', kind: 'todo' },
  { name: 'In progress', kind: 'doing' },
  { name: 'Blocked', kind: 'doing' },
  { name: 'Done', kind: 'done' },
];

function hasStatus(doc: Y.Doc, statusId: string): boolean {
  return statusesMap(doc).has(fieldKey(statusId, MADE, 'kind'));
}

/**
 * Writes a new status with the values it is made with; any later change to a
 * field outweighs them, so a status made on two replicas apart keeps a rename,
 * a kind, a move or an archive made on either. An archived time is written
 * only when there is one.
 */
export function writeNewStatus(doc: Y.Doc, status: Status): void {
  const statuses = statusesMap(doc);
  statuses.set(fieldKey(status.id, MADE, 'name'), status.name);
  statuses.set(fieldKey(status.id, MADE, 'kind'), status.kind);
  statuses.set(fieldKey(status.id, MADE, 'order'), status.order);
  if (status.archivedAt !== null) statuses.set(fieldKey(status.id, 'archivedAt'), status.archivedAt);
}

/**
 * Adds a status at `index` among the board's statuses; at the end when left
 * out. With `id`, a status that already has that id is left as it is, so two
 * replicas making the same status end with one.
 */
export function createStatus(doc: Y.Doc, input: { name: string; kind?: StatusKind; index?: number; id?: string }): Status {
  const { statuses, archivedStatuses } = readStatuses(doc);
  const existing = input.id === undefined ? undefined : [...statuses, ...archivedStatuses].find((status) => status.id === input.id);
  if (existing !== undefined) return existing;
  const status: Status = {
    id: input.id ?? newId(),
    name: input.name.trim() || 'Untitled',
    kind: input.kind ?? 'todo',
    order: orderAt(statuses, input.index ?? statuses.length),
    archivedAt: null,
  };
  doc.transact(() => writeNewStatus(doc, status));
  return status;
}

/** Changes the given fields of a status. */
function setStatusFields(doc: Y.Doc, statusId: string, fields: Partial<Omit<Status, 'id'>>): void {
  for (const [field, value] of Object.entries(fields)) {
    if (value !== undefined) statusesMap(doc).set(fieldKey(statusId, field), value);
  }
}

function requireStatus(doc: Y.Doc, statusId: string): void {
  if (!hasStatus(doc, statusId)) throw new Error(`No status has the id "${statusId}"`);
}

export function updateStatus(doc: Y.Doc, statusId: string, changes: { name?: string; kind?: StatusKind }): void {
  requireStatus(doc, statusId);
  const name = changes.name?.trim() || undefined;
  doc.transact(() => setStatusFields(doc, statusId, { name, kind: changes.kind }));
}

/** Moves a status to `index` among the statuses that are not archived. */
export function moveStatus(doc: Y.Doc, statusId: string, index: number): void {
  requireStatus(doc, statusId);
  const others = readStatuses(doc).statuses.filter((status) => status.id !== statusId);
  setStatusFields(doc, statusId, { order: orderAt(others, index) });
}

/** Hides a status and, with it, every card in it. The cards keep their status and come back with `restoreStatus`. */
export function archiveStatus(doc: Y.Doc, statusId: string): void {
  requireStatus(doc, statusId);
  setStatusFields(doc, statusId, { archivedAt: Date.now() });
}

export function restoreStatus(doc: Y.Doc, statusId: string): void {
  requireStatus(doc, statusId);
  setStatusFields(doc, statusId, { archivedAt: null });
}

/**
 * Adds a label at the end of the board's labels. The colour used least so far
 * when none is given. `section` is its label tie; none when left out.
 */
export function createLabel(doc: Y.Doc, input: { name: string; color?: LabelColor; section?: string | null }): Label {
  const siblings = readLabels(doc);
  const label: Label = {
    id: newId(),
    name: input.name.trim(),
    color: input.color ?? leastUsedLabelColor(siblings.map((sibling) => sibling.color)),
    order: orderAt(siblings, siblings.length),
    section: input.section ?? null,
  };
  doc.transact(() => {
    const map = new Y.Map<unknown>();
    map.set('name', label.name);
    map.set('color', label.color);
    map.set('order', label.order);
    map.set('section', label.section);
    labelsMap(doc).set(label.id, map);
  });
  return label;
}

/**
 * Changes a label's name, colour or tie. `section: null` unties it. A tie only
 * decides where new cards' pages are filed; changing it moves no page.
 */
export function updateLabel(doc: Y.Doc, labelId: string, changes: { name?: string; color?: LabelColor; section?: string | null }): void {
  const map = labelsMap(doc).get(labelId);
  if (map === undefined) throw new Error(`No label has the id "${labelId}"`);
  doc.transact(() => {
    if (changes.name !== undefined) map.set('name', changes.name.trim());
    if (changes.color !== undefined) map.set('color', changes.color);
    if (changes.section !== undefined) map.set('section', changes.section);
  });
}

/** Removes a label from the board. Cards that carried it keep its id, which readers skip. Deleting a label already gone does nothing. */
export function deleteLabel(doc: Y.Doc, labelId: string): void {
  labelsMap(doc).delete(labelId);
}
