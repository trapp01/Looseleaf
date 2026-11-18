/**
 * The replica store for browsers and the desktop shell: one IndexedDB
 * database with three object stores. `updates` holds one record per Yjs
 * update ({ docId, update }, auto-increment key, indexed by docId), `blobs`
 * maps hash → bytes, `settings` maps key → string. Writes commit with strict
 * durability, so a resolved append has reached the device's disk.
 */
import { CONTENT_VERSION } from './protocol.js';
import { blobHash, mergeDocUpdates, type ClientStore } from './replica-store.js';

export const DEFAULT_DATABASE_NAME = 'looseleaf';
/**
 * The database version is the content version (builds without one opened
 * version 1). A tab that opens a higher version closes every older build's
 * connection, and an older build cannot open it again, so no tab of an older
 * build reads content its editor would strip. Every store is kept as it is.
 */
export const DATABASE_VERSION = CONTENT_VERSION;
/** What a store's calls reject with once a tab of a newer build has opened the database. */
export const NEWER_BUILD_MESSAGE = 'A tab running a newer Looseleaf build has opened the notes on this device. Reload this tab to keep editing.';
const UPDATES = 'updates';
const BLOBS = 'blobs';
const SETTINGS = 'settings';
const BY_DOC = 'docId';

/** Opens (creating when needed) the IndexedDB replica store. `factory` defaults to the global `indexedDB`. */
export async function openIndexedDbStore(
  name: string = DEFAULT_DATABASE_NAME,
  factory: IdbFactory | undefined = (globalThis as { indexedDB?: IdbFactory }).indexedDB,
): Promise<IndexedDbStore> {
  if (factory === undefined) {
    throw new Error('IndexedDB is not available in this environment; pass an IDBFactory to openIndexedDbStore');
  }
  const request = factory.open(name, DATABASE_VERSION);
  request.onupgradeneeded = (event) => {
    if (event.oldVersion >= 1) return;
    const db = request.result;
    const updates = db.createObjectStore(UPDATES, { autoIncrement: true });
    updates.createIndex(BY_DOC, 'docId');
    db.createObjectStore(BLOBS);
    db.createObjectStore(SETTINGS);
  };
  // Every build closes its connection when asked, so the open goes on once the other tab has.
  request.onblocked = () => {
    console.warn(`IndexedDB "${name}" is waiting for a tab of an older build to close it`);
  };
  const db = await settle(request, `open IndexedDB "${name}"`);
  return new IndexedDbStore(db, name);
}

interface UpdateRecord {
  docId: string;
  update: Uint8Array;
}

export class IndexedDbStore implements ClientStore {
  private replaced = false;

  constructor(
    private readonly db: IdbDatabase,
    /** The IndexedDB database name. */
    readonly name: string,
  ) {
    // A tab of a newer build opening the database needs this connection gone.
    db.onversionchange = () => {
      this.replaced = true;
      db.close();
    };
  }

  close(): void {
    this.db.close();
  }

  appendUpdate(docId: string, update: Uint8Array): Promise<void> {
    return this.transact([UPDATES], 'readwrite', `append an update to ${docId}`, (tx) => {
      const record: UpdateRecord = { docId, update: ownBuffer(update) };
      tx.objectStore(UPDATES).add(record);
    });
  }

  async readUpdates(docId: string): Promise<Uint8Array[]> {
    const records = await this.transact<UpdateRecord[]>([UPDATES], 'readonly', `read the updates of ${docId}`, (tx, result) => {
      const request = tx.objectStore(UPDATES).index(BY_DOC).getAll(docId);
      request.onsuccess = () => result(request.result as UpdateRecord[]);
    });
    return (records ?? []).map((record) => record.update);
  }

  /** Reads, merges and replaces inside one transaction, so a concurrent append waits for it. */
  compact(docId: string): Promise<void> {
    return this.transact([UPDATES], 'readwrite', `compact ${docId}`, (tx) => {
      const store = tx.objectStore(UPDATES);
      const found: Uint8Array[] = [];
      const cursorRequest = store.index(BY_DOC).openCursor(docId);
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (cursor) {
          found.push((cursor.value as UpdateRecord).update);
          cursor.delete();
          cursor.continue();
          return;
        }
        if (found.length === 0) return;
        const record: UpdateRecord = { docId, update: mergeDocUpdates(found) };
        store.add(record);
      };
    });
  }

  async listDocs(): Promise<string[]> {
    const ids = await this.transact<string[]>([UPDATES], 'readonly', 'list docs', (tx, result) => {
      const seen: string[] = [];
      const request = tx.objectStore(UPDATES).index(BY_DOC).openKeyCursor(null, 'nextunique');
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return result(seen);
        seen.push(cursor.key as string);
        cursor.continue();
      };
    });
    return ids ?? [];
  }

  async putBlob(bytes: Uint8Array): Promise<string> {
    const hash = blobHash(bytes);
    await this.transact([BLOBS], 'readwrite', `store blob ${hash}`, (tx) => {
      tx.objectStore(BLOBS).put(ownBuffer(bytes), hash);
    });
    return hash;
  }

  async getBlob(hash: string): Promise<Uint8Array | null> {
    const bytes = await this.transact<Uint8Array | undefined>([BLOBS], 'readonly', `read blob ${hash}`, (tx, result) => {
      const request = tx.objectStore(BLOBS).get(hash);
      request.onsuccess = () => result(request.result as Uint8Array | undefined);
    });
    return bytes ?? null;
  }

  async hasBlob(hash: string): Promise<boolean> {
    const count = await this.transact<number>([BLOBS], 'readonly', `check blob ${hash}`, (tx, result) => {
      const request = tx.objectStore(BLOBS).count(hash);
      request.onsuccess = () => result(request.result as number);
    });
    return (count ?? 0) > 0;
  }

  async listBlobs(): Promise<string[]> {
    const keys = await this.transact<string[]>([BLOBS], 'readonly', 'list blobs', (tx, result) => {
      const request = tx.objectStore(BLOBS).getAllKeys();
      request.onsuccess = () => result(request.result as string[]);
    });
    return keys ?? [];
  }

  async getSetting(key: string): Promise<string | null> {
    const value = await this.transact<string | undefined>([SETTINGS], 'readonly', `read setting ${key}`, (tx, result) => {
      const request = tx.objectStore(SETTINGS).get(key);
      request.onsuccess = () => result(request.result as string | undefined);
    });
    return value ?? null;
  }

  setSetting(key: string, value: string | null): Promise<void> {
    return this.transact([SETTINGS], 'readwrite', `write setting ${key}`, (tx) => {
      const store = tx.objectStore(SETTINGS);
      if (value === null) store.delete(key);
      else store.put(value, key);
    });
  }

  /** Reads and writes inside one transaction; IndexedDB runs overlapping read-write transactions one at a time. */
  updateSetting(key: string, update: (value: string | null) => string | null): Promise<void> {
    return this.transact([SETTINGS], 'readwrite', `update setting ${key}`, (tx) => {
      const store = tx.objectStore(SETTINGS);
      const request = store.get(key);
      request.onsuccess = () => {
        const next = update((request.result as string | undefined) ?? null);
        if (next === null) store.delete(key);
        else store.put(next, key);
      };
    });
  }

  /**
   * Runs `body` in one transaction and resolves when the transaction commits,
   * with whatever the body passed to `result`. Rejects with `what` and the
   * database name when the transaction fails or aborts.
   */
  private transact<T>(
    stores: string[],
    mode: 'readonly' | 'readwrite',
    what: string,
    body: (tx: IdbTransaction, result: (value: T) => void) => void,
  ): Promise<T | undefined> {
    return new Promise((resolve, reject) => {
      if (this.replaced) {
        reject(new Error(NEWER_BUILD_MESSAGE));
        return;
      }
      let value: T | undefined;
      const tx = this.db.transaction(stores, mode, { durability: mode === 'readwrite' ? 'strict' : 'default' });
      const fail = () => reject(new Error(`Could not ${what} in IndexedDB "${this.name}": ${String(tx.error)}`));
      tx.oncomplete = () => resolve(value);
      tx.onerror = fail;
      tx.onabort = fail;
      body(tx, (result) => {
        value = result;
      });
    });
  }
}

/** Structured clone stores a view's whole buffer, so a view into a larger buffer is copied first. */
function ownBuffer(bytes: Uint8Array): Uint8Array {
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes : bytes.slice();
}

function settle<T>(request: IdbRequest<T>, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error(`Could not ${what}: ${String(request.error)}`));
  });
}

// The subset of the IndexedDB API this store uses. The package builds without
// the DOM lib, so these stand in for the browser's IDB* types.
export interface IdbFactory {
  open(name: string, version?: number): IdbOpenRequest;
}

interface IdbRequest<T> {
  readonly result: T;
  readonly error: unknown;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
}

interface IdbOpenRequest extends IdbRequest<IdbDatabase> {
  onupgradeneeded: ((event: { oldVersion: number }) => void) | null;
  onblocked: (() => void) | null;
}

interface IdbDatabase {
  createObjectStore(name: string, options?: { autoIncrement?: boolean }): IdbObjectStore;
  transaction(stores: string[], mode: 'readonly' | 'readwrite', options?: { durability: string }): IdbTransaction;
  close(): void;
  onversionchange: (() => void) | null;
}

interface IdbTransaction {
  objectStore(name: string): IdbObjectStore;
  readonly error: unknown;
  oncomplete: (() => void) | null;
  onerror: (() => void) | null;
  onabort: (() => void) | null;
}

interface IdbObjectStore {
  add(value: unknown, key?: string): IdbRequest<unknown>;
  put(value: unknown, key?: string): IdbRequest<unknown>;
  get(key: string): IdbRequest<unknown>;
  getAllKeys(): IdbRequest<unknown>;
  count(key: string): IdbRequest<unknown>;
  delete(key: string): IdbRequest<unknown>;
  createIndex(name: string, keyPath: string): unknown;
  index(name: string): IdbIndex;
}

interface IdbIndex {
  getAll(key: string): IdbRequest<unknown>;
  openCursor(key: string): IdbRequest<IdbCursorWithValue | null>;
  openKeyCursor(range: null, direction: 'nextunique'): IdbRequest<IdbCursor | null>;
}

interface IdbCursor {
  readonly key: unknown;
  continue(): void;
}

interface IdbCursorWithValue extends IdbCursor {
  readonly value: unknown;
  delete(): IdbRequest<unknown>;
}
