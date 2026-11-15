/**
 * The `library` doc: the list of notebooks. Every read and write of its
 * Y.Map keys happens in this file.
 */
import * as Y from 'yjs';
import { colorForIndex, isColorName, type ColorName } from './colors.js';
import { newId } from './ids.js';
import { orderAt, sortByOrder } from './order.js';

export interface NotebookEntry {
  id: string;
  name: string;
  color: ColorName;
  order: string;
  /** Epoch ms. */
  createdAt: number;
  /** Epoch ms, or null while the notebook is live. */
  deletedAt: number | null;
}

function notebooksMap(doc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return doc.getMap('notebooks');
}

function readEntry(id: string, map: Y.Map<unknown>): NotebookEntry {
  const color = map.get('color');
  return {
    id,
    name: String(map.get('name') ?? ''),
    color: isColorName(color) ? color : colorForIndex(0),
    order: String(map.get('order') ?? ''),
    createdAt: Number(map.get('createdAt') ?? 0),
    deletedAt: (map.get('deletedAt') as number | null | undefined) ?? null,
  };
}

function getNotebookMap(doc: Y.Doc, id: string): Y.Map<unknown> {
  const map = notebooksMap(doc).get(id);
  if (!map) throw new Error(`Notebook ${id} is not in the library`);
  return map;
}

function assertColor(color: string): asserts color is ColorName {
  if (!isColorName(color)) throw new Error(`"${color}" is not a notebook colour name`);
}

/** Notebooks in display order. Deleted ones are left out unless asked for. */
export function listNotebooks(doc: Y.Doc, options: { includeDeleted?: boolean } = {}): NotebookEntry[] {
  const entries: NotebookEntry[] = [];
  notebooksMap(doc).forEach((map, id) => {
    const entry = readEntry(id, map);
    if (options.includeDeleted || entry.deletedAt === null) entries.push(entry);
  });
  return sortByOrder(entries);
}

/** The notebook with this id, deleted or not, or null when there is none. */
export function getNotebook(doc: Y.Doc, id: string): NotebookEntry | null {
  const map = notebooksMap(doc).get(id);
  return map ? readEntry(id, map) : null;
}

/**
 * Adds a notebook and returns its id. `index` is the position among live
 * notebooks (default: last). Without a colour it takes the next palette
 * colour. The notebook doc itself starts empty and needs no setup.
 */
export function createNotebook(
  doc: Y.Doc,
  input: { name: string; color?: ColorName; index?: number; createdAt?: number },
): string {
  if (input.color !== undefined) assertColor(input.color);
  const siblings = listNotebooks(doc);
  const id = newId();
  doc.transact(() => {
    const map = new Y.Map<unknown>();
    notebooksMap(doc).set(id, map);
    map.set('name', input.name);
    map.set('color', input.color ?? colorForIndex(notebooksMap(doc).size - 1));
    map.set('order', orderAt(siblings, input.index ?? siblings.length));
    map.set('createdAt', input.createdAt ?? Date.now());
    map.set('deletedAt', null);
  });
  return id;
}

export function renameNotebook(doc: Y.Doc, id: string, name: string): void {
  getNotebookMap(doc, id).set('name', name);
}

export function setNotebookColor(doc: Y.Doc, id: string, color: ColorName): void {
  assertColor(color);
  getNotebookMap(doc, id).set('color', color);
}

/** Moves a notebook to `index` among the other live notebooks. */
export function moveNotebook(doc: Y.Doc, id: string, index: number): void {
  const map = getNotebookMap(doc, id);
  const siblings = listNotebooks(doc).filter((n) => n.id !== id);
  map.set('order', orderAt(siblings, index));
}

/** Marks a notebook deleted. Deleting a deleted notebook keeps its first deletedAt. */
export function deleteNotebook(doc: Y.Doc, id: string): void {
  const map = getNotebookMap(doc, id);
  if (map.get('deletedAt') == null) map.set('deletedAt', Date.now());
}

export function restoreNotebook(doc: Y.Doc, id: string): void {
  const map = getNotebookMap(doc, id);
  if (map.get('deletedAt') != null) map.set('deletedAt', null);
}

/**
 * Removes a notebook in Deleted notes from the library for good. A notebook
 * that is already gone is left alone. Throws for a notebook that is not deleted.
 * Its notebook and page docs stay in the replica, since no API deletes a doc.
 */
export function purgeNotebook(doc: Y.Doc, id: string): void {
  const map = notebooksMap(doc).get(id);
  if (!map) return;
  if (map.get('deletedAt') == null) throw new Error(`Cannot purge notebook ${id}: it is not in Deleted notes`);
  notebooksMap(doc).delete(id);
}
