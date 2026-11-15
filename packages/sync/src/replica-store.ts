/**
 * The replica store: where a replica keeps its docs and blobs. Doc ids and
 * bytes are opaque here. A doc is a list of Yjs updates; a blob is immutable
 * bytes named by their SHA-256. Three implementations exist: in memory (this
 * file, for tests), IndexedDB (browser and desktop) and disk (the server).
 */
import * as Y from 'yjs';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

export interface ReplicaStore {
  /** Appends one Yjs update to the doc, creating the doc when it is new. Resolves once the update is stored. */
  appendUpdate(docId: string, update: Uint8Array): Promise<void>;
  /** The doc's stored updates, oldest first; an empty list for a doc the store does not hold. */
  readUpdates(docId: string): Promise<Uint8Array[]>;
  /**
   * Replaces the doc's stored updates with one merged update. A crash during
   * the call leaves either the old updates or the merged one, never neither.
   * Updates appended while it runs are kept.
   */
  compact(docId: string): Promise<void>;
  /** Every doc id that has at least one stored update. */
  listDocs(): Promise<string[]>;
  /** Stores the bytes and resolves to their SHA-256 hex. Storing a blob twice is a no-op. */
  putBlob(bytes: Uint8Array): Promise<string>;
  getBlob(hash: string): Promise<Uint8Array | null>;
  hasBlob(hash: string): Promise<boolean>;
  listBlobs(): Promise<string[]>;
}

/** A small string key/value area for a device's settings, kept beside its replica. */
export interface SettingsStore {
  getSetting(key: string): Promise<string | null>;
  /** `null` removes the key. */
  setSetting(key: string, value: string | null): Promise<void>;
  /**
   * Replaces the value with `update(current)` as one atomic step, so tabs
   * sharing the store cannot overwrite each other's change. `update` must be
   * synchronous; returning null removes the key.
   */
  updateSetting(key: string, update: (value: string | null) => string | null): Promise<void>;
}

/** What a device's sync client needs: the replica plus its settings. */
export type ClientStore = ReplicaStore & SettingsStore;

/** The name of a blob: lowercase SHA-256 hex of its bytes. */
export function blobHash(bytes: Uint8Array): string {
  return bytesToHex(sha256(bytes));
}

export function isBlobHash(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

/**
 * True when the bytes decode as a whole Yjs update. Checked before an update
 * is stored or applied, so a truncated or corrupt one is refused instead of
 * half-applied or kept where it would break every later load.
 */
export function isReadableUpdate(update: Uint8Array): boolean {
  try {
    Y.decodeUpdate(update);
    return true;
  } catch {
    return false;
  }
}

/** True while the doc holds structs or deletions waiting for an update it has not seen yet. */
export function hasPendingUpdates(doc: Y.Doc): boolean {
  return doc.store.pendingStructs !== null || doc.store.pendingDs !== null;
}

/** Merges a doc's updates into one, the form every store's `compact` writes. */
export function mergeDocUpdates(updates: Uint8Array[]): Uint8Array {
  return updates.length === 1 ? updates[0]! : Y.mergeUpdates(updates);
}

/** Keeps everything in memory. Used by tests and as a stand-in when no persistent store exists. */
export class MemoryStore implements ClientStore {
  private readonly docs = new Map<string, Uint8Array[]>();
  private readonly blobs = new Map<string, Uint8Array>();
  private readonly settings = new Map<string, string>();

  async appendUpdate(docId: string, update: Uint8Array): Promise<void> {
    const updates = this.docs.get(docId) ?? [];
    updates.push(update.slice());
    this.docs.set(docId, updates);
  }

  async readUpdates(docId: string): Promise<Uint8Array[]> {
    return [...(this.docs.get(docId) ?? [])];
  }

  async compact(docId: string): Promise<void> {
    const updates = this.docs.get(docId);
    if (updates === undefined || updates.length < 2) return;
    this.docs.set(docId, [mergeDocUpdates(updates)]);
  }

  async listDocs(): Promise<string[]> {
    return [...this.docs.keys()];
  }

  async putBlob(bytes: Uint8Array): Promise<string> {
    const hash = blobHash(bytes);
    if (!this.blobs.has(hash)) this.blobs.set(hash, bytes.slice());
    return hash;
  }

  async getBlob(hash: string): Promise<Uint8Array | null> {
    return this.blobs.get(hash) ?? null;
  }

  async hasBlob(hash: string): Promise<boolean> {
    return this.blobs.has(hash);
  }

  async listBlobs(): Promise<string[]> {
    return [...this.blobs.keys()];
  }

  async getSetting(key: string): Promise<string | null> {
    return this.settings.get(key) ?? null;
  }

  async setSetting(key: string, value: string | null): Promise<void> {
    if (value === null) this.settings.delete(key);
    else this.settings.set(key, value);
  }

  async updateSetting(key: string, update: (value: string | null) => string | null): Promise<void> {
    await this.setSetting(key, update(this.settings.get(key) ?? null));
  }
}
