import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  createNotebook,
  deleteNotebook,
  getNotebook,
  listNotebooks,
  moveNotebook,
  purgeNotebook,
  renameNotebook,
  restoreNotebook,
  setNotebookColor,
  type ColorName,
} from '../src/index.js';

const names = (doc: Y.Doc, includeDeleted = false) => listNotebooks(doc, { includeDeleted }).map((n) => n.name);

describe('library', () => {
  it('creates notebooks in order with distinct default colours', () => {
    const doc = new Y.Doc();
    const a = createNotebook(doc, { name: 'Work' });
    createNotebook(doc, { name: 'Home' });
    createNotebook(doc, { name: 'First', index: 0 });
    expect(names(doc)).toEqual(['First', 'Work', 'Home']);
    const work = getNotebook(doc, a)!;
    expect(work).toMatchObject({ id: a, name: 'Work', deletedAt: null });
    expect(work.createdAt).toBeGreaterThan(0);
    expect(new Set(listNotebooks(doc).map((n) => n.color)).size).toBe(3);
  });

  it('stores the layout the architecture describes', () => {
    const doc = new Y.Doc();
    const id = createNotebook(doc, { name: 'Work', color: 'teal' });
    const raw = (doc.getMap('notebooks').get(id) as Y.Map<unknown>).toJSON();
    expect(Object.keys(raw).sort()).toEqual(['color', 'createdAt', 'deletedAt', 'name', 'order']);
    expect(raw.color).toBe('teal');
  });

  it('renames, recolours and reorders', () => {
    const doc = new Y.Doc();
    const a = createNotebook(doc, { name: 'A' });
    const b = createNotebook(doc, { name: 'B' });
    createNotebook(doc, { name: 'C' });
    renameNotebook(doc, a, 'Alpha');
    setNotebookColor(doc, b, 'plum');
    moveNotebook(doc, a, 2);
    expect(names(doc)).toEqual(['B', 'C', 'Alpha']);
    moveNotebook(doc, a, 0);
    expect(names(doc)).toEqual(['Alpha', 'B', 'C']);
    expect(getNotebook(doc, b)!.color).toBe('plum');
  });

  it('rejects unknown colours and unknown ids', () => {
    const doc = new Y.Doc();
    const a = createNotebook(doc, { name: 'A' });
    expect(() => setNotebookColor(doc, a, 'chartreuse' as ColorName)).toThrow(/chartreuse/);
    expect(() => renameNotebook(doc, 'missing', 'x')).toThrow(/missing/);
  });

  it('deletes and restores, and deleting twice keeps the first time', async () => {
    const doc = new Y.Doc();
    const a = createNotebook(doc, { name: 'A' });
    createNotebook(doc, { name: 'B' });
    deleteNotebook(doc, a);
    const first = getNotebook(doc, a)!.deletedAt!;
    expect(first).toBeGreaterThan(0);
    expect(names(doc)).toEqual(['B']);
    expect(names(doc, true)).toEqual(['A', 'B']);
    await new Promise((r) => setTimeout(r, 2));
    deleteNotebook(doc, a);
    expect(getNotebook(doc, a)!.deletedAt).toBe(first);
    restoreNotebook(doc, a);
    restoreNotebook(doc, a);
    expect(names(doc)).toEqual(['A', 'B']);
  });

  it('purges only a deleted notebook, and purging one already gone succeeds', () => {
    const doc = new Y.Doc();
    const a = createNotebook(doc, { name: 'A' });
    createNotebook(doc, { name: 'B' });
    expect(() => purgeNotebook(doc, a)).toThrow(new RegExp(`${a}.*not in Deleted notes`));
    expect(names(doc)).toEqual(['A', 'B']);
    deleteNotebook(doc, a);
    purgeNotebook(doc, a);
    expect(getNotebook(doc, a)).toBeNull();
    expect(names(doc, true)).toEqual(['B']);
    purgeNotebook(doc, a);
    purgeNotebook(doc, 'never-there');
  });

  it('returns null for a notebook that is not there', () => {
    expect(getNotebook(new Y.Doc(), 'nope')).toBeNull();
  });
});
