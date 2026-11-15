/**
 * The one owner of what is selected: notebook, section and page. It remembers
 * per device the last notebook, each notebook's last section and each
 * section's last page, and `reconcile` repairs the selection against the live
 * tree after any change (a deletion on another device, a fresh sync, a move).
 */
import type { NotebookTree, TreeChild, SectionEntry } from '@looseleaf/model';
import { Store } from './store.js';
import { readLocal, writeLocal } from './local-settings.js';

export interface Selection {
  notebookId: string | null;
  sectionId: string | null;
  pageId: string | null;
}

export interface SelectionMemory {
  notebook: string | null;
  sectionByNotebook: Record<string, string>;
  pageBySection: Record<string, string>;
}

const MEMORY_KEY = 'selection';
const EMPTY: Selection = { notebookId: null, sectionId: null, pageId: null };

export class SelectionStore extends Store<Selection> {
  private memory: SelectionMemory;

  constructor() {
    const memory = readLocal<SelectionMemory>(MEMORY_KEY, { notebook: null, sectionByNotebook: {}, pageBySection: {} });
    super({ ...EMPTY, notebookId: memory.notebook });
    this.memory = memory;
  }

  override set(next: Selection): void {
    super.set(next);
    this.memory = remember(this.memory, next);
    writeLocal(MEMORY_KEY, this.memory);
  }

  selectNotebook(notebookId: string): void {
    if (notebookId === this.get().notebookId) return;
    const sectionId = this.memory.sectionByNotebook[notebookId] ?? null;
    this.set({ notebookId, sectionId, pageId: sectionId ? (this.memory.pageBySection[sectionId] ?? null) : null });
  }

  selectSection(sectionId: string): void {
    const current = this.get();
    if (sectionId === current.sectionId) return;
    this.set({ ...current, sectionId, pageId: this.memory.pageBySection[sectionId] ?? null });
  }

  /** Selects a page, switching notebook and section when given. */
  selectPage(pageId: string, sectionId?: string, notebookId?: string): void {
    const current = this.get();
    this.set({
      notebookId: notebookId ?? current.notebookId,
      sectionId: sectionId ?? current.sectionId,
      pageId,
    });
  }

  /** Repairs the selection against the live library and the selected notebook's tree (null while loading). */
  reconcile(notebookIds: string[], tree: NotebookTree | null): void {
    const next = reconcileSelection(this.get(), this.memory, notebookIds, tree);
    if (next.notebookId !== this.get().notebookId || next.sectionId !== this.get().sectionId || next.pageId !== this.get().pageId) {
      this.set(next);
    }
  }
}

function remember(memory: SelectionMemory, s: Selection): SelectionMemory {
  const next: SelectionMemory = {
    notebook: s.notebookId ?? memory.notebook,
    sectionByNotebook: { ...memory.sectionByNotebook },
    pageBySection: { ...memory.pageBySection },
  };
  if (s.notebookId && s.sectionId) next.sectionByNotebook[s.notebookId] = s.sectionId;
  if (s.sectionId && s.pageId) next.pageBySection[s.sectionId] = s.pageId;
  return next;
}

/** Every section in a tree, depth first in display order. */
export function allSections(children: TreeChild[]): SectionEntry[] {
  return children.flatMap((c) => (c.kind === 'section' ? [c] : allSections(c.children)));
}

/**
 * The selection with every id that no longer exists replaced: by the
 * remembered choice when that still exists, else by the first one, else null.
 * While the notebook's tree is still loading (null), section and page are kept.
 */
export function reconcileSelection(
  s: Selection,
  memory: SelectionMemory,
  notebookIds: string[],
  tree: NotebookTree | null,
): Selection {
  let notebookId = s.notebookId;
  if (notebookId === null || !notebookIds.includes(notebookId)) {
    notebookId = memory.notebook && notebookIds.includes(memory.notebook) ? memory.notebook : (notebookIds[0] ?? null);
  }
  if (notebookId === null) return EMPTY;
  if (notebookId !== s.notebookId) {
    const sectionId = memory.sectionByNotebook[notebookId] ?? null;
    return { notebookId, sectionId, pageId: sectionId ? (memory.pageBySection[sectionId] ?? null) : null };
  }
  if (tree === null) return s;

  const sections = allSections(tree.children);
  let section = sections.find((x) => x.id === s.sectionId);
  if (!section) {
    const remembered = memory.sectionByNotebook[notebookId];
    section = sections.find((x) => x.id === remembered) ?? sections[0];
  }
  if (!section) return { notebookId, sectionId: null, pageId: null };

  let page = section.pages.find((p) => p.id === s.pageId);
  if (!page) {
    const remembered = memory.pageBySection[section.id];
    page = section.pages.find((p) => p.id === remembered) ?? section.pages[0];
  }
  return { notebookId, sectionId: section.id, pageId: page?.id ?? null };
}
