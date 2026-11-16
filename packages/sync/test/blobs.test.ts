import { describe, expect, it } from 'vitest';
import { BLOB_TRANSFER_CONCURRENCY, BlobSync } from '../src/blobs.js';
import { blobHash, MemoryStore } from '../src/replica-store.js';
import type { FetchInit, FetchLike, FetchResponse } from '../src/transport.js';

function response(body: unknown): FetchResponse {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    arrayBuffer: async () => new ArrayBuffer(0),
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

/** A server that lists no blobs and takes a few milliseconds per upload, counting uploads in flight. */
function countingServer() {
  const counts = { inFlight: 0, maxInFlight: 0, uploaded: 0 };
  const fetch: FetchLike = async (_url: string, init?: FetchInit) => {
    if (init?.method !== 'PUT') return response({ blobs: [] });
    counts.inFlight += 1;
    counts.maxInFlight = Math.max(counts.maxInFlight, counts.inFlight);
    await new Promise((resolve) => setTimeout(resolve, 3));
    counts.inFlight -= 1;
    counts.uploaded += 1;
    return response({});
  };
  return { counts, fetch };
}

describe('BlobSync', () => {
  it(`uploads put blobs at most ${BLOB_TRANSFER_CONCURRENCY} at a time while connected`, async () => {
    const { counts, fetch } = countingServer();
    const errors: string[] = [];
    const blobs = await BlobSync.create(
      new MemoryStore(),
      fetch,
      { onChange: () => undefined, onError: (_kind, error) => errors.push(error.message), onStored: () => undefined },
      { min: 20, max: 40 },
    );
    const access = { address: 'http://hub.test', token: 't' };
    blobs.setConfigured(access);
    blobs.goOnline(access);
    await Promise.all(Array.from({ length: 50 }, (_, i) => blobs.put(new TextEncoder().encode(`blob ${i}`))));
    const deadline = Date.now() + 2000;
    while (blobs.unsentCount > 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(blobs.unsentCount).toBe(0);
    expect(counts.uploaded).toBeGreaterThanOrEqual(50);
    expect(counts.maxInFlight).toBeLessThanOrEqual(BLOB_TRANSFER_CONCURRENCY);
    expect(counts.maxInFlight).toBeGreaterThan(1);
    expect(errors).toEqual([]);
    await blobs.close();
  });
});

describe('BlobSync onStored', () => {
  it('reports a blob put here and a blob downloaded on demand, once each is in the store', async () => {
    const remoteBytes = new TextEncoder().encode('a picture from another device');
    const remoteHash = blobHash(remoteBytes);
    const fetch: FetchLike = async (url) =>
      url.endsWith(remoteHash) ? { ...response({}), arrayBuffer: async () => remoteBytes.slice().buffer } : response({ blobs: [] });
    const store = new MemoryStore();
    const stored: string[] = [];
    const blobs = await BlobSync.create(
      store,
      fetch,
      { onChange: () => undefined, onError: () => undefined, onStored: (hash) => stored.push(hash) },
      { min: 20, max: 40 },
    );
    const localHash = await blobs.put(new TextEncoder().encode('a picture taken here'));
    expect(stored).toEqual([localHash]);
    expect(await store.getBlob(localHash)).not.toBeNull();

    blobs.setConfigured({ address: 'http://hub.test', token: 't' });
    expect(await blobs.get(remoteHash)).toEqual(remoteBytes);
    expect(stored).toEqual([localHash, remoteHash]);
    expect(await store.getBlob(remoteHash)).toEqual(remoteBytes);
    await blobs.close();
  });
});
