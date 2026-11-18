/**
 * A board itself: making one on a notebook, and its key. Board keys are
 * unique across a server's boards so a card ref names one card. Any replica
 * picks a key; only servers repair two boards that picked the same one.
 */
import type * as Y from 'yjs';
import { metaMap, readBoardMeta, type BoardMeta } from './board.js';
import { DEFAULT_STATUSES, createStatus } from './statuses.js';

export const BOARD_KEY_MAX_LENGTH = 6;

/** Uppercase letters and digits only, starting with a letter, at most BOARD_KEY_MAX_LENGTH long; '' when nothing is left. */
export function normalizeBoardKey(text: string): string {
  return text
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .replace(/^[0-9]+/, '')
    .slice(0, BOARD_KEY_MAX_LENGTH);
}

/**
 * A key for a board on a notebook called `name` that is not in `taken`: the
 * initials of a name of several words, else its first three letters, with a
 * number added when that is taken.
 */
export function suggestBoardKey(name: string, taken: readonly string[]): string {
  const words = name.split(/[^A-Za-z0-9]+/).filter((word) => /[A-Za-z]/.test(word));
  const initials = normalizeBoardKey(words.map((word) => word[0]).join(''));
  const base = (initials.length >= 2 ? initials : normalizeBoardKey(words[0] ?? '').slice(0, 3)) || 'BRD';
  return uniqueKey(base, taken);
}

function uniqueKey(base: string, taken: readonly string[]): string {
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = String(n);
    const key = base.slice(0, BOARD_KEY_MAX_LENGTH - suffix.length) + suffix;
    if (!taken.includes(key)) return key;
  }
}

/** The id of a new board's n-th default status. Derived from the notebook so two replicas that make the board apart make the same statuses. */
function defaultStatusId(notebookId: string, index: number): string {
  return `${notebookId}-status-${index + 1}`;
}

/**
 * Makes the board on an empty board doc: its key, its created time and the
 * default statuses. `name` is the notebook's name, for a key when none is
 * asked for; `takenKeys` are the keys of every other board on the replica. A
 * key that is left out, empty after normalizing, or taken is replaced by a
 * free one. Throws when the doc already holds a board.
 */
export function createBoard(
  doc: Y.Doc,
  input: { notebookId: string; name: string; key?: string; takenKeys: readonly string[]; now?: number },
): BoardMeta {
  const existing = readBoardMeta(doc);
  if (existing !== null) throw new Error(`This notebook already has a board, with the key ${existing.key}`);
  const asked = normalizeBoardKey(input.key ?? '');
  const meta: BoardMeta = {
    key: asked === '' ? suggestBoardKey(input.name, input.takenKeys) : uniqueKey(asked, input.takenKeys),
    createdAt: input.now ?? Date.now(),
    unfiledSection: null,
  };
  doc.transact(() => {
    const map = metaMap(doc);
    map.set('key', meta.key);
    map.set('createdAt', meta.createdAt);
    map.set('unfiledSection', null);
    DEFAULT_STATUSES.forEach((status, index) => createStatus(doc, { ...status, id: defaultStatusId(input.notebookId, index) }));
  });
  return meta;
}

/** Sets a board's key. People cannot change a key, since refs written elsewhere contain it; servers call this to repair a clash. */
export function setBoardKey(doc: Y.Doc, key: string): void {
  metaMap(doc).set('key', key);
}

/**
 * The key changes that give every board a key of its own. Two replicas that
 * each made a board while apart can pick the same key; the board made first
 * keeps it and the others get a number added. A key only one board uses is
 * never changed. Only servers apply these (with `setBoardKey`), so two
 * replicas never repair in different directions.
 */
export function boardKeyRepairs(boards: ReadonlyArray<{ notebookId: string; key: string; createdAt: number }>): Array<{ notebookId: string; key: string }> {
  const sorted = [...boards].sort((a, b) => a.createdAt - b.createdAt || (a.notebookId < b.notebookId ? -1 : 1));
  const taken = new Set<string>();
  const clashing = sorted.filter((board) => {
    if (board.key !== '' && !taken.has(board.key)) {
      taken.add(board.key);
      return false;
    }
    return true;
  });
  return clashing.map((board) => {
    const key = uniqueKey(normalizeBoardKey(board.key) || 'BRD', [...taken]);
    taken.add(key);
    return { notebookId: board.notebookId, key };
  });
}
