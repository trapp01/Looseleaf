/**
 * Keeps every live notebook's doc open for the session, so the section list,
 * search, recent pages, export and the move picker read trees without
 * waiting. Notebook docs are small; page docs are opened only when needed.
 * The React hooks here are the only place the navigation observes Yjs.
 */
import * as Y from 'yjs';
import type { SyncClient } from '@looseleaf/sync';
import {
  listDeletedNodes,
  listNotebooks,
  notebookDocId,
  readTree,
  type NodeEntry,
  type NotebookEntry,
  type NotebookTree,
} from '@looseleaf/model';
import { Store } from '../app/store.js';
import { useYValue } from '../app/yjs-hooks.js';

export class NotebookDocs {
  readonly docs = new Store<ReadonlyMap<string, Y.Doc>>(new Map());
  private readonly opening = new Set<string>();

  constructor(
    private readonly client: SyncClient,
    readonly library: Y.Doc,
  ) {
    library.on('update', this.sync);
    this.sync();
  }

  get(notebookId: string | null): Y.Doc | null {
    return notebookId ? (this.docs.get().get(notebookId) ?? null) : null;
  }

  /** The notebook's doc, opening it first when needed. */
  async load(notebookId: string): Promise<Y.Doc> {
    const open = this.get(notebookId);
    if (open) return open;
    const doc = await this.client.openDoc(notebookDocId(notebookId));
    if (this.docs.get().has(notebookId)) {
      this.client.releaseDoc(notebookDocId(notebookId));
      return this.docs.get().get(notebookId)!;
    }
    this.docs.update((m) => new Map(m).set(notebookId, doc));
    return doc;
  }

  private readonly sync = () => {
    for (const notebook of listNotebooks(this.library)) {
      if (this.docs.get().has(notebook.id) || this.opening.has(notebook.id)) continue;
      this.opening.add(notebook.id);
      this.load(notebook.id)
        .catch((error: unknown) => console.error(`Could not open notebook ${notebook.id}`, error))
        .finally(() => this.opening.delete(notebook.id));
    }
  };
}

const EMPTY_TREE: NotebookTree = { children: [] };

/** Live notebooks in display order. */
export function useNotebooks(library: Y.Doc): NotebookEntry[] {
  return useYValue(library, () => listNotebooks(library));
}

/** Deleted notebooks, for Deleted notes. */
export function useDeletedNotebooks(library: Y.Doc): NotebookEntry[] {
  return useYValue(library, () => listNotebooks(library, { includeDeleted: true }).filter((n) => n.deletedAt !== null));
}

/** The live tree of a notebook doc; empty while it loads. */
export function useNotebookTree(doc: Y.Doc | null): NotebookTree {
  return useYValue(doc, () => (doc ? readTree(doc) : EMPTY_TREE));
}

export function useDeletedNodes(doc: Y.Doc | null): NodeEntry[] {
  return useYValue(doc, () => (doc ? listDeletedNodes(doc) : []));
}
