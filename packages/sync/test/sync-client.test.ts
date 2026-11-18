import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { openIndexedDbStore, type IdbFactory } from '../src/indexeddb-store.js';
import { CLIENT_TOO_OLD_REASON, CLOSE_CLIENT_TOO_OLD, CONTENT_VERSION } from '../src/protocol.js';
import { COMPACT_AFTER_UPDATES } from '../src/replica.js';
import { MemoryStore } from '../src/replica-store.js';
import { SyncClient } from '../src/sync-client.js';
import type { SocketConstructor, SocketLike } from '../src/transport.js';

/** A socket that never connects: it reports a close shortly after it is made. */
class UnreachableSocket implements SocketLike {
  binaryType = '';
  onopen: SocketLike['onopen'] = null;
  onmessage: SocketLike['onmessage'] = null;
  onclose: SocketLike['onclose'] = null;
  onerror: SocketLike['onerror'] = null;
  constructor(readonly url: string) {
    setTimeout(() => this.onclose?.({ code: 1006, reason: '' }), 1);
  }
  send(): void {
    throw new Error('not connected');
  }
  close(): void {}
}

/** A socket to a server whose content version is above this build's: it opens, takes the hello and refuses it. */
class RefusingSocket implements SocketLike {
  static opened = 0;
  static hellos: string[] = [];
  binaryType = '';
  onopen: SocketLike['onopen'] = null;
  onmessage: SocketLike['onmessage'] = null;
  onclose: SocketLike['onclose'] = null;
  onerror: SocketLike['onerror'] = null;
  constructor(readonly url: string) {
    RefusingSocket.opened += 1;
    setTimeout(() => this.onopen?.({}), 1);
  }
  send(data: string | Uint8Array): void {
    if (typeof data !== 'string') throw new Error('binary frame before the welcome');
    RefusingSocket.hellos.push(data);
    setTimeout(() => this.onclose?.({ code: CLOSE_CLIENT_TOO_OLD, reason: CLIENT_TOO_OLD_REASON }), 1);
  }
  close(): void {}
}

/** A memory store whose doc writes take a few milliseconds and can be refused. */
class SlowStore extends MemoryStore {
  refuse = false;
  override async appendUpdate(docId: string, update: Uint8Array): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 2));
    if (this.refuse) throw new Error('QuotaExceededError');
    return super.appendUpdate(docId, update);
  }
}

const noFetch = async () => {
  throw new Error('offline');
};

function offlineClient(store = new MemoryStore()) {
  return SyncClient.create({
    store,
    WebSocket: UnreachableSocket as unknown as SocketConstructor,
    fetch: noFetch,
    reconnectDelayMs: { min: 20, max: 40 },
  });
}

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('SyncClient with no server', () => {
  it('opens docs, returns one instance per id, and keeps edits in the store', async () => {
    const store = new MemoryStore();
    const client = await offlineClient(store);
    expect(client.status.state).toBe('no-server');
    const doc = await client.openDoc('pg:a');
    expect(await client.openDoc('pg:a')).toBe(doc);
    doc.getText('t').insert(0, 'offline words');
    await client.close();

    const again = await offlineClient(store);
    const reopened = await again.openDoc('pg:a');
    expect(reopened.getText('t').toString()).toBe('offline words');
    expect(again.replicaId).toBe(client.replicaId);
    expect(again.status.unsentDocs).toBe(0);
    await again.close();
  });

  it('unloads a released doc and loads it again from the store', async () => {
    const client = await offlineClient();
    const doc = await client.openDoc('pg:a');
    await client.openDoc('pg:a');
    doc.getMap('m').set('k', 1);
    client.releaseDoc('pg:a');
    client.releaseDoc('pg:a');
    expect(() => client.releaseDoc('pg:a')).toThrow(/more times than openDoc/);
    // The doc stays loaded until its change is stored.
    await new Promise((resolve) => setTimeout(resolve, 10));
    const next = await client.openDoc('pg:a');
    expect(next).not.toBe(doc);
    expect(next.getMap('m').get('k')).toBe(1);
    await client.close();
  });

  it(`compacts a doc's stored updates once there are more than ${COMPACT_AFTER_UPDATES}`, async () => {
    const store = new MemoryStore();
    const client = await offlineClient(store);
    const doc = await client.openDoc('pg:a');
    for (let i = 0; i < COMPACT_AFTER_UPDATES + 5; i++) {
      doc.getText('t').insert(i, 'x');
      await until(() => true);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await client.close();
    const stored = await store.readUpdates('pg:a');
    expect(stored.length).toBeLessThan(COMPACT_AFTER_UPDATES);
    const reopened = await (await offlineClient(store)).openDoc('pg:a');
    expect(reopened.getText('t').length).toBe(COMPACT_AFTER_UPDATES + 5);
  });

  it('flush() resolves once every edit so far is in a slow store', async () => {
    const store = new SlowStore();
    const client = await offlineClient(store);
    const ids = Array.from({ length: 300 }, (_, i) => `pg:${i}`);
    for (const id of ids) {
      const doc = await client.openDoc(id);
      doc.getText('t').insert(0, `page ${id}`);
      client.releaseDoc(id);
    }
    await client.flush();
    expect((await store.listDocs()).sort()).toEqual([...ids].sort());
    for (const id of ids) expect(await store.readUpdates(id)).not.toHaveLength(0);
    // Nothing was closed: docs still open and edits keep being stored.
    const doc = await client.openDoc('pg:0');
    expect(doc.getText('t').toString()).toBe('page pg:0');
    await client.close();
  });

  it('flush() rejects, naming the docs, while the store refuses writes, and resolves once it accepts them', async () => {
    const store = new SlowStore();
    const client = await offlineClient(store);
    const doc = await client.openDoc('pg:r');
    store.refuse = true;
    doc.getText('t').insert(0, 'refused');
    await expect(client.flush()).rejects.toThrow(/refused changes to 1 doc\(s\): pg:r/);
    store.refuse = false;
    await client.flush();
    expect(await store.readUpdates('pg:r')).not.toHaveLength(0);
    await client.close();
  });

  it('reports each doc change and blob it stores to onDocStored and onBlobStored', async () => {
    const client = await offlineClient();
    const docs: string[] = [];
    const blobs: string[] = [];
    client.onDocStored((docId) => docs.push(docId));
    const stop = client.onBlobStored((hash) => blobs.push(hash));
    const doc = await client.openDoc('pg:a');
    doc.getText('t').insert(0, 'stored');
    await client.flush();
    expect(docs).toEqual(['pg:a']);
    const hash = await client.putBlob(new Uint8Array([1, 2, 3]));
    expect(blobs).toEqual([hash]);
    stop();
    await client.putBlob(new Uint8Array([4]));
    expect(blobs).toEqual([hash]);
    await client.close();
  });

  it('rejects an address that is not http(s) and a blank token', async () => {
    const client = await offlineClient();
    await expect(client.connect({ url: 'nas', token: 't' })).rejects.toThrow(/http/);
    await expect(client.connect({ url: 'http://nas', token: ' ' })).rejects.toThrow(/token/);
    expect(client.status.state).toBe('no-server');
    await client.close();
  });
});

describe('SyncClient with an unreachable server', () => {
  it('reports offline and unreachable, retries, counts unsent docs, and remembers the server', async () => {
    const store = new MemoryStore();
    const client = await offlineClient(store);
    await client.connect({ url: 'http://nowhere.invalid:8421', token: 'secret' });
    await until(() => client.status.lastError?.kind === 'unreachable');
    expect(client.status.state).toBe('offline');
    expect(client.status.nextRetryAt).not.toBeNull();
    const doc = await client.openDoc('pg:a');
    doc.getText('t').insert(0, 'not sent yet');
    await until(() => client.status.unsentDocs === 1);
    await client.close();

    const restarted = await offlineClient(store);
    expect(restarted.status.server).toBe('http://nowhere.invalid:8421');
    expect(restarted.status.unsentDocs).toBe(1);
    expect(await restarted.getBlob('0'.repeat(64))).toBeNull();
    await restarted.disconnect();
    expect(restarted.status.state).toBe('no-server');
    await restarted.close();
  });
});

describe('SyncClient refused by a newer server', () => {
  it('reports outdated, keeps local edits in the store and retries only at the slowest pace', async () => {
    const store = new MemoryStore();
    const client = await SyncClient.create({
      store,
      WebSocket: RefusingSocket as unknown as SocketConstructor,
      fetch: noFetch,
      reconnectDelayMs: { min: 5, max: 400 },
    });
    const doc = await client.openDoc('pg:a');
    doc.getText('t').insert(0, 'kept here');
    await client.connect({ url: 'http://nas:8421', token: 'secret' });
    await until(() => client.status.lastError?.kind === 'outdated');
    expect(client.status.state).toBe('offline');
    expect(client.status.lastError?.message).toBe(CLIENT_TOO_OLD_REASON);
    expect(JSON.parse(RefusingSocket.hellos[0]!).content).toBe(CONTENT_VERSION);
    // With a 5 ms minimum, ordinary backoff would have tried several times by now.
    expect(client.status.nextRetryAt! - Date.now()).toBeGreaterThan(150);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(RefusingSocket.opened).toBe(1);
    await client.flush();
    expect((await store.readUpdates('pg:a')).length).toBeGreaterThan(0);
    expect(client.status.server).toBe('http://nas:8421');
    await client.close();
  });
});

describe('tabs sharing a store', () => {
  const textOf = async (client: SyncClient) => (await client.openDoc('pg:a')).getText('t').toString();

  it('show each other’s edits in the same build, and never a tab’s of another build', async () => {
    const factory = new IDBFactory() as unknown as IdbFactory;
    const name = 'looseleaf-tabs';
    const open = async (options: { tabChannel?: string } = {}) =>
      SyncClient.create({ ...options, store: await openIndexedDbStore(name, factory), WebSocket: UnreachableSocket as unknown as SocketConstructor, fetch: noFetch });
    const first = await open();
    const second = await open();
    // A tab of a build older than the content version, on the channel name those builds use.
    const older = await SyncClient.create({ store: new MemoryStore(), tabChannel: `looseleaf:${name}`, WebSocket: UnreachableSocket as unknown as SocketConstructor, fetch: noFetch });
    for (const client of [first, second, older]) await client.openDoc('pg:a');

    const secondDoc = await second.openDoc('pg:a');
    (await first.openDoc('pg:a')).getText('t').insert(0, 'from this build');
    await until(() => secondDoc.getText('t').toString() === 'from this build');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await textOf(older)).toBe('');

    (await older.openDoc('pg:a')).getText('t').insert(0, 'from an older build ');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await textOf(first)).toBe('from this build');
    expect(await textOf(second)).toBe('from this build');
    for (const client of [first, second, older]) await client.close();
  });
});
