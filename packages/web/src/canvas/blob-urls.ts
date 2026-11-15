/**
 * The one cache of object URLs for blobs. Every picture and file on screen
 * borrows its URL here: `acquire` while shown, `release` when gone. A URL is
 * revoked once nobody has held it for `graceMs`, so a re-render that releases
 * and re-acquires does not refetch. A blob this device lacks is "missing" and
 * fetched again by `retryMissing`, which `retryMissingOnSync` calls as sync
 * progresses.
 */
import { useEffect, useSyncExternalStore } from 'react';
import type { SyncClient, SyncStatus } from '@looseleaf/sync';

/** While syncing, missing blobs are fetched again at most this often. */
export const BLOB_RETRY_INTERVAL_MS = 3000;

export type BlobState = { status: 'loading' } | { status: 'ready'; url: string } | { status: 'missing' };

interface Entry {
  hash: string;
  mime: string;
  refs: number;
  state: BlobState;
  revokeTimer: ReturnType<typeof setTimeout> | null;
  fetching: boolean;
}

export interface BlobUrlDeps {
  getBlob(hash: string): Promise<Uint8Array | null>;
  createUrl?(blob: Blob): string;
  revokeUrl?(url: string): void;
  graceMs?: number;
}

const LOADING: BlobState = { status: 'loading' };

export class BlobUrlCache {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<() => void>();
  private readonly createUrl: (blob: Blob) => string;
  private readonly revokeUrl: (url: string) => void;
  private readonly graceMs: number;

  constructor(private readonly deps: BlobUrlDeps) {
    this.createUrl = deps.createUrl ?? ((blob) => URL.createObjectURL(blob));
    this.revokeUrl = deps.revokeUrl ?? ((url) => URL.revokeObjectURL(url));
    this.graceMs = deps.graceMs ?? 10_000;
  }

  /** Starts (or joins) loading the blob; pair with `release`. */
  acquire(hash: string, mime: string): void {
    let entry = this.entries.get(hash);
    if (!entry) {
      entry = { hash, mime, refs: 0, state: LOADING, revokeTimer: null, fetching: false };
      this.entries.set(hash, entry);
      void this.load(entry);
    }
    entry.refs++;
    if (entry.revokeTimer) {
      clearTimeout(entry.revokeTimer);
      entry.revokeTimer = null;
    }
  }

  release(hash: string): void {
    const entry = this.entries.get(hash);
    if (!entry || entry.refs === 0) return;
    entry.refs--;
    if (entry.refs > 0) return;
    entry.revokeTimer = setTimeout(() => this.drop(entry), this.graceMs);
  }

  state(hash: string): BlobState {
    return this.entries.get(hash)?.state ?? LOADING;
  }

  /** Fetches every held blob that was missing; the sync client may have it by now. */
  retryMissing(): void {
    for (const entry of this.entries.values()) {
      if (entry.state.status === 'missing' && entry.refs > 0) void this.load(entry);
    }
  }

  /** Revokes every URL. */
  clear(): void {
    for (const entry of [...this.entries.values()]) this.drop(entry);
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private async load(entry: Entry): Promise<void> {
    if (entry.fetching) return;
    entry.fetching = true;
    let bytes: Uint8Array | null = null;
    try {
      bytes = await this.deps.getBlob(entry.hash);
    } catch {
      bytes = null;
    }
    entry.fetching = false;
    if (this.entries.get(entry.hash) !== entry) return;
    entry.state = bytes
      ? { status: 'ready', url: this.createUrl(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: entry.mime })) }
      : { status: 'missing' };
    this.notify();
  }

  private drop(entry: Entry): void {
    if (entry.revokeTimer) clearTimeout(entry.revokeTimer);
    if (entry.state.status === 'ready') this.revokeUrl(entry.state.url);
    this.entries.delete(entry.hash);
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

/** The blob's state for as long as the component is mounted. Pass a null hash to hold nothing. */
export function useBlobUrl(cache: BlobUrlCache, hash: string | null, mime: string): BlobState {
  useEffect(() => {
    if (!hash) return;
    cache.acquire(hash, mime);
    return () => cache.release(hash);
  }, [cache, hash, mime]);
  const get = () => (hash ? cache.state(hash) : LOADING);
  return useSyncExternalStore(cache.subscribe, get, get);
}

/**
 * Fetches missing blobs again when the client becomes synced, when the count
 * of unsent blobs drops, and at most every BLOB_RETRY_INTERVAL_MS while
 * syncing. Returns the unsubscribe function.
 */
export function retryMissingOnSync(
  client: Pick<SyncClient, 'status' | 'onStatus'>,
  cache: Pick<BlobUrlCache, 'retryMissing'>,
  now: () => number = Date.now,
): () => void {
  let previous: SyncStatus = client.status;
  let lastRetry = -Infinity;
  return client.onStatus((status) => {
    const becameSynced = status.state === 'synced' && previous.state !== 'synced';
    const blobsSent = status.unsentBlobs < previous.unsentBlobs;
    const due = status.state === 'syncing' && now() - lastRetry >= BLOB_RETRY_INTERVAL_MS;
    previous = status;
    if (!becameSynced && !blobsSent && !due) return;
    lastRetry = now();
    cache.retryMissing();
  });
}
