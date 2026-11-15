/**
 * A device's replica in memory: the docs that are loaded, backed by the
 * replica store. Every change to a loaded doc, local or remote, is appended to
 * the store; local changes are handed to `onLocalChange` once stored. When
 * the store refuses a write, the local changes are handed on anyway, so the
 * server holds a second copy, and stay queued here (the doc stays loaded)
 * until a retry stores them. Docs that are not loaded take remote updates
 * straight into the store. All store work for one doc runs in order through
 * one queue, so a load always sees every append queued before it.
 */
import * as Y from 'yjs';
import { KeyedQueue } from './keyed-queue.js';
import { PersistedIdSet } from './persisted-id-set.js';
import { hasPendingUpdates, isReadableUpdate, mergeDocUpdates, type ClientStore } from './replica-store.js';

/** A doc's stored updates are merged into one once there are more than this many. */
export const COMPACT_AFTER_UPDATES = 200;
/** How long to wait before retrying a failed store write. */
const STORE_RETRY_MS = 2000;
const UNSENT_DOCS_SETTING = 'unsentDocs';

/** Transaction origin for updates already in the store (read back, or written by another tab); not stored again. */
const FROM_STORE = Symbol('from-store');
/** Transaction origin for updates received from the server; they are stored but not sent back. */
const FROM_SERVER = Symbol('from-server');

interface Change {
  update: Uint8Array;
  local: boolean;
  /** True once handed to `onLocalChange`, which happens early when the store refuses it. */
  handedOn: boolean;
}

interface Entry {
  readonly id: string;
  readonly doc: Y.Doc;
  readonly ready: Promise<void>;
  /** True once the stored updates have been applied. */
  loaded: boolean;
  /** Handles held by the UI through `open`. */
  uiRefs: number;
  /** Handles held by sync while it handshakes the doc. */
  syncHolds: number;
  /** Changes waiting to be appended to the store, in the order they happened. */
  unstored: Change[];
  storeQueued: boolean;
  /** True while the last attempt to store this doc's changes failed. */
  storeFailing: boolean;
}

export interface ReplicaEvents {
  /** A local change has been stored, or the store refused it, and it may now be sent. */
  onLocalChange(docId: string, update: Uint8Array): void;
  /** A store operation failed. Writes are retried; the error is for status. */
  onStoreError(error: Error): void;
  /** The number of unsent or unstored docs changed. */
  onCountsChange(): void;
}

export class Replica {
  private readonly entries = new Map<string, Entry>();
  private readonly queue = new KeyedQueue();
  /** Stored update count per doc, known once the doc has been loaded in this session. */
  private readonly storedCounts = new Map<string, number>();
  /** Docs with stored updates that do not decode; they are skipped on load and never compacted. */
  private readonly unreadableDocs = new Set<string>();
  private readonly retryTimers = new Set<ReturnType<typeof setTimeout>>();
  private closed = false;

  private constructor(
    readonly store: ClientStore,
    private readonly events: ReplicaEvents,
    private readonly unsent: PersistedIdSet,
  ) {}

  static async create(store: ClientStore, events: ReplicaEvents): Promise<Replica> {
    const unsent = await PersistedIdSet.load(store, UNSENT_DOCS_SETTING, (error) => events.onStoreError(error));
    return new Replica(store, events, unsent);
  }

  /** Loads the doc (or reuses the loaded instance) for the UI. Pair every call with `release`. */
  async open(docId: string): Promise<Y.Doc> {
    const entry = this.entry(docId);
    entry.uiRefs += 1;
    await entry.ready;
    return entry.doc;
  }

  /** Drops one UI handle. The doc is unloaded once no handle, sync hold or unstored change remains. */
  release(docId: string): void {
    const entry = this.entries.get(docId);
    if (entry === undefined || entry.uiRefs === 0) {
      throw new Error(`releaseDoc("${docId}") called more times than openDoc`);
    }
    entry.uiRefs -= 1;
    this.unloadIfUnused(entry);
  }

  /** Loads the doc for sync. Pair every call with `unhold`. */
  async hold(docId: string): Promise<Y.Doc> {
    const entry = this.entry(docId);
    entry.syncHolds += 1;
    await entry.ready;
    return entry.doc;
  }

  unhold(docId: string): void {
    const entry = this.entries.get(docId);
    if (entry === undefined || entry.syncHolds === 0) return;
    entry.syncHolds -= 1;
    this.unloadIfUnused(entry);
  }

  listStoredDocs(): Promise<string[]> {
    return this.store.listDocs();
  }

  /**
   * Applies an update from the server. Resolves once it is stored, whether or
   * not the doc is loaded. Rejects, storing nothing, when the update does not
   * decode.
   */
  async applyRemote(docId: string, update: Uint8Array): Promise<void> {
    await this.queue.run(docId, async () => {
      if (!isReadableUpdate(update)) throw new Error(`The server sent an update for doc "${docId}" that does not decode`);
      // An entry that is still loading reads this append from the store instead.
      const entry = this.entries.get(docId);
      if (!entry?.loaded) {
        await this.appendStored(docId, update);
        return;
      }
      Y.applyUpdate(entry.doc, update, FROM_SERVER);
      // The part waiting on a missing dependency is in no update event; keep the raw update so it survives.
      if (hasPendingUpdates(entry.doc)) await this.appendStored(docId, update);
    });
    // Applying queued a store write for the loaded doc; wait for it as well.
    await this.queue.run(docId, async () => undefined);
  }

  /** Shows an update another tab has already stored in this tab's loaded doc. Does nothing when not loaded. */
  async applyFromOtherTab(docId: string, update: Uint8Array): Promise<void> {
    await this.queue.run(docId, async () => {
      const entry = this.entries.get(docId);
      if (entry?.loaded && isReadableUpdate(update)) Y.applyUpdate(entry.doc, update, FROM_STORE);
    });
  }

  /**
   * Runs `use` on the loaded doc inside the doc's queue: after its load and
   * every write queued before, and before any local change stored after. The
   * doc must be held or open.
   */
  withDoc<T>(docId: string, use: (doc: Y.Doc) => T): Promise<T> {
    return this.queue.run(docId, async () => use(this.loadedEntry(docId).doc));
  }

  /**
   * Like `withDoc`, but first applies whatever the store holds that the loaded
   * doc lacks, such as edits another tab stored. Used before a handshake Diff.
   */
  withStoredDoc<T>(docId: string, use: (doc: Y.Doc) => T): Promise<T> {
    return this.queue.run(docId, async () => {
      const entry = this.loadedEntry(docId);
      const updates = (await this.store.readUpdates(docId)).filter(isReadableUpdate);
      if (updates.length > 0) Y.applyUpdate(entry.doc, mergeDocUpdates(updates), FROM_STORE);
      return use(entry.doc);
    });
  }

  unsentCount(): number {
    return this.unsent.size;
  }

  /** Docs holding changes the store has refused; they stay loaded until a retry stores them. */
  unstoredCount(): number {
    let count = 0;
    for (const entry of this.entries.values()) if (entry.storeFailing) count += 1;
    return count;
  }

  /** Records that the doc has local changes the server has not been sent. */
  markUnsent(docId: string): void {
    if (this.unsent.add(docId)) this.events.onCountsChange();
  }

  markSent(docId: string): void {
    if (this.unsent.delete(docId)) this.events.onCountsChange();
  }

  /**
   * Waits for every queued store write and retries refused ones once, leaving
   * every doc as it is. Rejects, naming the docs, when the store still refuses
   * some changes; later retries carry on.
   */
  async flush(): Promise<void> {
    const unstored = await this.storeAll();
    if (unstored.length > 0) throw refusedChangesError(unstored);
  }

  /**
   * Waits for every queued store write, retries refused ones once, then
   * unloads every doc. Rejects, naming the docs, when the store still refuses
   * some changes; those docs are left loaded so their content can be read.
   */
  async close(): Promise<void> {
    const unstored = await this.storeAll();
    this.closed = true;
    for (const timer of this.retryTimers) clearTimeout(timer);
    this.retryTimers.clear();
    for (const entry of this.entries.values()) if (entry.unstored.length === 0) entry.doc.destroy();
    this.entries.clear();
    if (unstored.length > 0) throw refusedChangesError(unstored);
  }

  /** Drains the store queue, retries refused changes once, and returns the docs whose changes are still unstored. */
  private async storeAll(): Promise<string[]> {
    await this.queue.drain();
    for (const entry of this.entries.values()) if (entry.unstored.length > 0) this.queueStore(entry);
    await this.queue.drain();
    await this.unsent.flushed();
    return [...this.entries.values()].filter((entry) => entry.unstored.length > 0).map((entry) => entry.id);
  }

  private entry(docId: string): Entry {
    if (this.closed) throw new Error(`Cannot open doc "${docId}": the sync client is closed`);
    const existing = this.entries.get(docId);
    if (existing !== undefined) return existing;
    const doc = new Y.Doc();
    const ready = this.queue.run(docId, () => this.load(entry)).catch((error: unknown) => {
      if (this.entries.get(docId) === entry) this.entries.delete(docId);
      doc.destroy();
      throw new Error(`Could not load doc "${docId}" from the replica store: ${String(error)}`);
    });
    const entry: Entry = {
      id: docId,
      doc,
      ready,
      loaded: false,
      uiRefs: 0,
      syncHolds: 0,
      unstored: [],
      storeQueued: false,
      storeFailing: false,
    };
    doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === FROM_STORE) return;
      entry.unstored.push({ update, local: origin !== FROM_SERVER, handedOn: false });
      this.queueStore(entry);
    });
    this.entries.set(docId, entry);
    return entry;
  }

  /** Applies the stored updates. Updates that do not decode are skipped and reported; a handshake restores them. */
  private async load(entry: Entry): Promise<void> {
    const updates = await this.store.readUpdates(entry.id);
    const readable = updates.filter(isReadableUpdate);
    if (readable.length < updates.length) {
      this.unreadableDocs.add(entry.id);
      this.events.onStoreError(
        new Error(
          `Skipped ${updates.length - readable.length} stored update(s) of doc "${entry.id}" that do not decode; ` +
            'the next handshake restores what the server has',
        ),
      );
    }
    if (readable.length > 0) Y.applyUpdate(entry.doc, mergeDocUpdates(readable), FROM_STORE);
    entry.loaded = true;
    this.storedCounts.set(entry.id, updates.length);
    await this.compactIfNeeded(entry.id);
  }

  private loadedEntry(docId: string): Entry {
    const entry = this.entries.get(docId);
    if (entry === undefined) throw new Error(`Doc "${docId}" is not loaded; hold it before handshaking`);
    return entry;
  }

  private unloadIfUnused(entry: Entry): void {
    if (entry.uiRefs > 0 || entry.syncHolds > 0 || entry.unstored.length > 0 || entry.storeQueued) return;
    if (this.entries.get(entry.id) !== entry) return;
    this.entries.delete(entry.id);
    entry.doc.destroy();
  }

  private queueStore(entry: Entry): void {
    if (entry.storeQueued || this.closed) return;
    entry.storeQueued = true;
    void this.queue.run(entry.id, () => this.storeChanges(entry));
  }

  /** Appends the entry's unstored changes as one merged update, then hands on the local ones. */
  private async storeChanges(entry: Entry): Promise<void> {
    entry.storeQueued = false;
    const batch = entry.unstored.splice(0);
    if (batch.length === 0) return;
    try {
      await this.store.appendUpdate(entry.id, mergeDocUpdates(batch.map((change) => change.update)));
    } catch (error) {
      entry.unstored.unshift(...batch);
      this.events.onStoreError(new Error(`Could not store changes to doc "${entry.id}": ${String(error)}`));
      this.setStoreFailing(entry, true);
      this.handOn(entry.id, batch);
      this.retryLater(entry);
      return;
    }
    this.countStored(entry.id, 1);
    this.setStoreFailing(entry, false);
    await this.compactIfNeeded(entry.id);
    this.handOn(entry.id, batch);
    this.unloadIfUnused(entry);
  }

  /** Hands the batch's local changes that were not handed on yet to `onLocalChange`, as one update. */
  private handOn(docId: string, batch: Change[]): void {
    const fresh = batch.filter((change) => change.local && !change.handedOn);
    if (fresh.length === 0) return;
    for (const change of fresh) change.handedOn = true;
    this.events.onLocalChange(docId, mergeDocUpdates(fresh.map((change) => change.update)));
  }

  private setStoreFailing(entry: Entry, failing: boolean): void {
    if (entry.storeFailing === failing) return;
    entry.storeFailing = failing;
    this.events.onCountsChange();
  }

  private retryLater(entry: Entry): void {
    if (this.closed) return;
    const timer = setTimeout(() => {
      this.retryTimers.delete(timer);
      this.queueStore(entry);
    }, STORE_RETRY_MS);
    this.retryTimers.add(timer);
  }

  /** Appends an update that is already in Yjs form. Runs inside the doc's queue. */
  private async appendStored(docId: string, update: Uint8Array): Promise<void> {
    await this.store.appendUpdate(docId, update);
    this.countStored(docId, 1);
  }

  private countStored(docId: string, added: number): void {
    const count = this.storedCounts.get(docId);
    if (count !== undefined) this.storedCounts.set(docId, count + added);
  }

  /** Runs inside the doc's queue. A failed compaction leaves the updates as they were. */
  private async compactIfNeeded(docId: string): Promise<void> {
    if (this.unreadableDocs.has(docId)) return;
    if ((this.storedCounts.get(docId) ?? 0) <= COMPACT_AFTER_UPDATES) return;
    try {
      await this.store.compact(docId);
      this.storedCounts.set(docId, 1);
    } catch (error) {
      this.events.onStoreError(new Error(`Could not compact doc "${docId}": ${String(error)}`));
    }
  }
}

function refusedChangesError(docIds: string[]): Error {
  return new Error(
    `The replica store refused changes to ${docIds.length} doc(s): ${docIds.join(', ')}. ` +
      'They were sent to the server if it was connected; otherwise they exist only in memory.',
  );
}
