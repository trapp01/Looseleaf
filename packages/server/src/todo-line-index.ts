/**
 * The server's To Do line index: each page's To Do lines, as `listTodoLines`
 * reads them, kept current as page docs are stored. The board tools take the
 * Inbox and card checklists from it instead of opening every page on each
 * call. A stored page is only marked; marked pages are read again before the
 * index is next read, so storing a change costs a set insert and the index is
 * never behind what is on disk. At start every page is read in the
 * background. Pages are read from the store into throwaway docs, never
 * through the hub, so building the index neither fills the hub's cache nor
 * waits behind sync work.
 */
import * as Y from 'yjs';
import { listTodoLines, type TodoLine } from '@looseleaf/model';
import type { DiskStore } from './disk-store.js';

const PAGE_PREFIX = 'pg:';

export class TodoLineIndex {
  /** Pages with at least one To Do line, by page id. */
  private readonly lines = new Map<string, readonly TodoLine[]>();
  /** Pages stored since they were last read. */
  private readonly marked = new Set<string>();
  private loading: Promise<void> = Promise.resolve();
  private running: Promise<void> | null = null;
  private closed = false;

  constructor(private readonly store: DiskStore) {}

  /** Marks every stored page and starts reading them in the background. */
  start(): void {
    this.loading = this.store
      .listDocs()
      .then((ids) => {
        for (const id of ids) if (id.startsWith(PAGE_PREFIX)) this.marked.add(id.slice(PAGE_PREFIX.length));
      })
      .catch((error: unknown) => console.error('Could not list the pages for the To Do line index; pages join it as they are stored', error));
    void this.current();
  }

  /** Called after a doc update is on disk. */
  docStored(docId: string): void {
    if (docId.startsWith(PAGE_PREFIX)) this.marked.add(docId.slice(PAGE_PREFIX.length));
  }

  /** Every page's To Do lines, by page id, once every page stored so far has been read. Pages with no lines are left out. */
  async current(): Promise<ReadonlyMap<string, readonly TodoLine[]>> {
    await this.loading;
    while (this.running !== null) await this.running;
    if (this.marked.size > 0 && !this.closed) {
      const batch = [...this.marked];
      this.marked.clear();
      this.running = this.read(batch).finally(() => {
        this.running = null;
      });
      await this.running;
    }
    return this.lines;
  }

  /** Waits for a read in progress. Pages marked after this are not read. */
  async close(): Promise<void> {
    this.closed = true;
    await this.running?.catch(() => undefined);
  }

  private async read(pageIds: string[]): Promise<void> {
    for (const pageId of pageIds) {
      if (this.closed) return;
      try {
        const doc = await this.readStoredDoc(`${PAGE_PREFIX}${pageId}`);
        const found = listTodoLines(doc);
        doc.destroy();
        if (found.length > 0) this.lines.set(pageId, found);
        else this.lines.delete(pageId);
      } catch (error) {
        // The page keeps its last known lines; its next stored change reads it again.
        console.error(`Could not read page ${pageId} for the To Do line index`, error);
      }
    }
  }

  private async readStoredDoc(docId: string): Promise<Y.Doc> {
    const updates = await this.store.readUpdates(docId);
    const doc = new Y.Doc();
    if (updates.length > 0) Y.applyUpdate(doc, Y.mergeUpdates(updates));
    return doc;
  }
}
