import { describe, expect, it } from 'vitest';
import { BLOB_TRANSFER_CONCURRENCY, BlobSync } from '../src/blobs.js';
import { MemoryStore } from '../src/replica-store.js';
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
      { onChange: () => undefined, onError: (_kind, error) => errors.push(error.message) },
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
