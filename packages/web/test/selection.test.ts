// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import type { NotebookTree } from '@looseleaf/model';
import { reconcileSelection, SelectionStore, type SelectionMemory } from '../src/app/selection.js';

const tree: NotebookTree = {
  children: [
    { kind: 'section', id: 's1', name: 'One', color: 'blue', createdAt: 0, modifiedAt: 0, pages: [
      { id: 'p1', title: 'A', level: 0, createdAt: 0, modifiedAt: 0 },
      { id: 'p2', title: 'B', level: 0, createdAt: 0, modifiedAt: 0 },
    ] },
    { kind: 'group', id: 'g1', name: 'Group', createdAt: 0, modifiedAt: 0, children: [
      { kind: 'section', id: 's2', name: 'Two', color: 'red', createdAt: 0, modifiedAt: 0, pages: [{ id: 'p3', title: 'C', level: 0, createdAt: 0, modifiedAt: 0 }] },
    ] },
  ],
};
const empty: SelectionMemory = { notebook: null, sectionByNotebook: {}, pageBySection: {} };

describe('reconcileSelection', () => {
  it('fills an empty selection with the first notebook, section and page', () => {
    const s = reconcileSelection({ notebookId: null, sectionId: null, pageId: null }, empty, ['n1', 'n2'], null);
    expect(s).toEqual({ notebookId: 'n1', sectionId: null, pageId: null });
    expect(reconcileSelection(s, empty, ['n1'], tree)).toEqual({ notebookId: 'n1', sectionId: 's1', pageId: 'p1' });
  });

  it('prefers what was remembered, including a section inside a group', () => {
    const memory: SelectionMemory = { notebook: 'n2', sectionByNotebook: { n2: 's2' }, pageBySection: { s2: 'p3', s1: 'p2' } };
    const s = reconcileSelection({ notebookId: null, sectionId: null, pageId: null }, memory, ['n1', 'n2'], null);
    expect(s).toEqual({ notebookId: 'n2', sectionId: 's2', pageId: 'p3' });
    expect(reconcileSelection(s, memory, ['n1', 'n2'], tree)).toEqual(s);
  });

  it('replaces a page or section deleted elsewhere', () => {
    const memory: SelectionMemory = { notebook: 'n1', sectionByNotebook: {}, pageBySection: { s1: 'p2' } };
    expect(reconcileSelection({ notebookId: 'n1', sectionId: 's1', pageId: 'gone' }, memory, ['n1'], tree)).toEqual({ notebookId: 'n1', sectionId: 's1', pageId: 'p2' });
    expect(reconcileSelection({ notebookId: 'n1', sectionId: 'gone', pageId: 'gone' }, empty, ['n1'], tree)).toEqual({ notebookId: 'n1', sectionId: 's1', pageId: 'p1' });
    expect(reconcileSelection({ notebookId: 'gone', sectionId: 's1', pageId: 'p1' }, empty, [], null)).toEqual({ notebookId: null, sectionId: null, pageId: null });
  });

  it('keeps section and page while the tree is still loading', () => {
    const s = { notebookId: 'n1', sectionId: 'sX', pageId: 'pX' };
    expect(reconcileSelection(s, empty, ['n1'], null)).toBe(s);
  });
});

describe('SelectionStore', () => {
  beforeEach(() => localStorage.clear());

  it('remembers the last section per notebook and page per section across instances', () => {
    const a = new SelectionStore();
    a.set({ notebookId: 'n1', sectionId: 's1', pageId: 'p2' });
    a.selectNotebook('n2');
    a.set({ notebookId: 'n2', sectionId: 's9', pageId: 'p9' });
    const b = new SelectionStore();
    expect(b.get().notebookId).toBe('n2');
    b.selectNotebook('n1');
    expect(b.get()).toEqual({ notebookId: 'n1', sectionId: 's1', pageId: 'p2' });
  });

  it('runs on defaults when storage throws', () => {
    const original = Storage.prototype.getItem;
    Storage.prototype.getItem = () => {
      throw new Error('blocked');
    };
    try {
      const store = new SelectionStore();
      expect(store.get()).toEqual({ notebookId: null, sectionId: null, pageId: null });
      store.selectPage('p1', 's1', 'n1');
      expect(store.get().pageId).toBe('p1');
    } finally {
      Storage.prototype.getItem = original;
    }
  });
});
