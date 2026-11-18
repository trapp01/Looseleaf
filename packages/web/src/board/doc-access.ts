/** The model's `DocAccess` over this device's replica, for board changes that span the board, notebook and page docs. */
import type * as Y from 'yjs';
import type { SyncClient } from '@looseleaf/sync';
import type { DocAccess } from '@looseleaf/model';

/**
 * The transaction origin of every change made through `replicaDocAccess`. A
 * page's undo history does not track it, so Ctrl+Z on a page never undoes half
 * of a change that also touched the board or the notebook.
 */
export const BOARD_CHANGE_ORIGIN = 'board-change';

/** Opens the doc (or reuses it when already open), runs the change in one transaction, and releases it. */
export function replicaDocAccess(client: Pick<SyncClient, 'openDoc' | 'releaseDoc'>): DocAccess {
  return {
    async withDoc<T>(docId: string, change: (doc: Y.Doc) => T): Promise<T> {
      const doc = await client.openDoc(docId);
      try {
        let result!: T;
        doc.transact(() => {
          result = change(doc);
        }, BOARD_CHANGE_ORIGIN);
        return result;
      } finally {
        client.releaseDoc(docId);
      }
    },
  };
}
