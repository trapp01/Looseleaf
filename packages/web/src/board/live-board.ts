/**
 * The board of the selected notebook. `LiveBoard` keeps `board:<notebookId>`
 * open beside the notebook doc, re-reads it with `readBoard` after every
 * change to either doc, and notes the cards a change from elsewhere (another
 * device or an agent) touched in the last FLASH_MS, so card fronts can flash.
 * Components read it through `useCurrentBoard`; nothing else observes the
 * board doc.
 */
import type * as Y from 'yjs';
import type { SyncClient } from '@looseleaf/sync';
import { boardDocId, findCard, readBoard, readBoardMeta, type BoardSnapshot, type Card } from '@looseleaf/model';
import type { SelectionStore } from '../app/selection.js';
import { useServices } from '../app/services.js';
import { Store, useStore } from '../app/store.js';
import type { NotebookDocs } from '../nav/notebook-docs.js';
import { changedCardIds } from './live-changes.js';

export const FLASH_MS = 1600;

const NONE: ReadonlySet<string> = new Set();

export interface CurrentBoard {
  notebookId: string;
  /** The board doc, for the model's board writers. */
  doc: Y.Doc;
  notebookDoc: Y.Doc;
  board: BoardSnapshot;
  /** Cards changed from elsewhere moments ago. */
  flashing: ReadonlySet<string>;
}

interface Target {
  notebookId: string;
  notebookDoc: Y.Doc;
}

export class LiveBoard {
  /** The selected notebook's board; null while it loads and while the notebook has none. */
  readonly current = new Store<CurrentBoard | null>(null);
  private target: Target | null = null;
  private stop: () => void = () => undefined;

  constructor(
    private readonly client: Pick<SyncClient, 'openDoc' | 'releaseDoc'>,
    private readonly selection: SelectionStore,
    private readonly notebooks: NotebookDocs,
  ) {
    selection.subscribe(this.follow);
    notebooks.docs.subscribe(this.follow);
    this.follow();
  }

  private readonly follow = () => {
    const notebookId = this.selection.get().notebookId;
    const notebookDoc = this.notebooks.get(notebookId);
    if (this.target?.notebookId === notebookId && this.target.notebookDoc === notebookDoc) return;
    this.stop();
    this.stop = () => undefined;
    this.current.set(null);
    this.target = notebookId && notebookDoc ? { notebookId, notebookDoc } : null;
    const target = this.target;
    if (!target) return;
    const docId = boardDocId(target.notebookId);
    this.client.openDoc(docId).then(
      (doc) => {
        if (this.target !== target) return this.client.releaseDoc(docId);
        const stopWatching = this.watch(target, doc);
        this.stop = () => {
          stopWatching();
          this.client.releaseDoc(docId);
        };
      },
      (error: unknown) => console.error(`Could not open ${docId}`, error),
    );
  };

  private watch({ notebookId, notebookDoc }: Target, doc: Y.Doc): () => void {
    const read = () => (readBoardMeta(doc) ? readBoard(doc, notebookDoc) : null);
    let board = read();
    let timers = new Map<string, ReturnType<typeof setTimeout>>();
    const publish = () => {
      const flashing = timers.size === 0 ? NONE : new Set(timers.keys());
      this.current.set(board ? { notebookId, doc, notebookDoc, board, flashing } : null);
    };
    const onUpdate = (_update: Uint8Array, _origin: unknown, _doc: Y.Doc, transaction: Y.Transaction) => {
      const next = read();
      // Changes from sync or another tab are not local; edits made here are.
      if (!transaction.local && board && next) {
        for (const id of changedCardIds(board, next)) {
          clearTimeout(timers.get(id));
          timers.set(
            id,
            setTimeout(() => {
              timers.delete(id);
              publish();
            }, FLASH_MS),
          );
        }
      }
      board = next;
      publish();
    };
    doc.on('update', onUpdate);
    notebookDoc.on('update', onUpdate);
    publish();
    return () => {
      doc.off('update', onUpdate);
      notebookDoc.off('update', onUpdate);
      for (const timer of timers.values()) clearTimeout(timer);
      timers = new Map();
    };
  }
}

/** The selected notebook's board, or null while it loads and while the notebook has none. */
export function useCurrentBoard(): CurrentBoard | null {
  return useStore(useServices().boards.current);
}

/** The card a page is, when it is a card on the board and not archived; else null. */
export function liveCard(board: BoardSnapshot, pageId: string): Card | null {
  const card = findCard(board, pageId);
  return card && card.archivedAt === null && card.sectionId !== null ? card : null;
}
