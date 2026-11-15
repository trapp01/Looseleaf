import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SyncStatus } from '@looseleaf/sync';
import { BLOB_RETRY_INTERVAL_MS, BlobUrlCache, retryMissingOnSync } from '../src/canvas/blob-urls.js';

describe('BlobUrlCache', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const setup = (stored: Record<string, Uint8Array | null>) => {
    const created: string[] = [];
    const revoked: string[] = [];
    const fetched: string[] = [];
    const cache = new BlobUrlCache({
      getBlob: async (hash) => {
        fetched.push(hash);
        return stored[hash] ?? null;
      },
      createUrl: () => {
        const url = `blob:${created.length}`;
        created.push(url);
        return url;
      },
      revokeUrl: (url) => revoked.push(url),
      graceMs: 1000,
    });
    return { cache, created, revoked, fetched };
  };

  it('shares one URL between holders and revokes it once nobody has held it for the grace time', async () => {
    const { cache, created, revoked, fetched } = setup({ h1: new Uint8Array([1]) });
    cache.acquire('h1', 'image/png');
    cache.acquire('h1', 'image/png');
    await vi.runAllTimersAsync();
    expect(cache.state('h1')).toEqual({ status: 'ready', url: 'blob:0' });
    cache.release('h1');
    cache.release('h1');
    cache.acquire('h1', 'image/png');
    await vi.advanceTimersByTimeAsync(2000);
    expect(revoked).toEqual([]);
    cache.release('h1');
    await vi.advanceTimersByTimeAsync(1000);
    expect(revoked).toEqual(['blob:0']);
    expect(created).toHaveLength(1);
    expect(fetched).toEqual(['h1']);
  });

  it('marks a missing blob and fetches it again on retry', async () => {
    const stored: Record<string, Uint8Array | null> = { h2: null };
    const { cache, fetched } = setup(stored);
    const notify = vi.fn();
    cache.subscribe(notify);
    cache.acquire('h2', 'image/png');
    await vi.runAllTimersAsync();
    expect(cache.state('h2')).toEqual({ status: 'missing' });
    stored.h2 = new Uint8Array([2]);
    cache.retryMissing();
    await vi.runAllTimersAsync();
    expect(cache.state('h2').status).toBe('ready');
    expect(fetched).toEqual(['h2', 'h2']);
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('clear revokes every URL', async () => {
    const { cache, revoked } = setup({ a: new Uint8Array([1]), b: new Uint8Array([2]) });
    cache.acquire('a', 'x');
    cache.acquire('b', 'x');
    await vi.runAllTimersAsync();
    cache.clear();
    expect(revoked.sort()).toEqual(['blob:0', 'blob:1']);
  });
});

describe('retryMissingOnSync', () => {
  const status = (state: SyncStatus['state'], unsentBlobs = 0) => ({ state, unsentBlobs }) as SyncStatus;

  it('retries on becoming synced, when unsent blobs drop, and at most every interval while syncing', () => {
    let listener: (s: SyncStatus) => void = () => undefined;
    let clock = 0;
    const retryMissing = vi.fn();
    retryMissingOnSync(
      {
        status: status('connecting', 3),
        onStatus: (l) => {
          listener = l;
          return () => undefined;
        },
      },
      { retryMissing },
      () => clock,
    );
    listener(status('syncing', 3));
    expect(retryMissing).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 50; i++) listener(status('syncing', 3));
    expect(retryMissing).toHaveBeenCalledTimes(1);
    clock = BLOB_RETRY_INTERVAL_MS;
    listener(status('syncing', 3));
    expect(retryMissing).toHaveBeenCalledTimes(2);
    listener(status('syncing', 2));
    expect(retryMissing).toHaveBeenCalledTimes(3);
    listener(status('synced', 2));
    expect(retryMissing).toHaveBeenCalledTimes(4);
    listener(status('synced', 2));
    expect(retryMissing).toHaveBeenCalledTimes(4);
  });
});
