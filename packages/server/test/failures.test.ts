/**
 * Failures that must stay contained: a store that refuses writes, an
 * unreadable doc on either side, updates that fail to apply or wait on a
 * missing dependency, a failing compaction, a second tab, failed blob uploads.
 */
import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { FrameType, MemoryStore, type FetchLike, type SyncStatus } from '@looseleaf/sync';
import { docFolderName, DiskStore } from '../src/disk-store.js';
import {
  connectedClient,
  contentOf,
  docFromStore,
  editDoc,
  makeClient,
  nextState,
  nodeFetch,
  rawSocket,
  sendFrame,
  SocketControl,
  TestServer,
  TOKEN,
  updatesOf,
  waitFor,
  waitForConvergence,
  waitForSynced,
} from './harness.js';

/** A store whose appends or reads can be made to fail, as a full or broken disk would. */
class FlakyStore extends MemoryStore {
  failAppends = false;
  failReadsOf = new Set<string>();
  override async appendUpdate(docId: string, update: Uint8Array): Promise<void> {
    if (this.failAppends) throw new Error('QuotaExceededError');
    return super.appendUpdate(docId, update);
  }
  override async readUpdates(docId: string): Promise<Uint8Array[]> {
    if (this.failReadsOf.has(docId)) throw new Error('UnknownError reading the store');
    return super.readUpdates(docId);
  }
}

function quietly<T>(run: () => Promise<T>): Promise<T> {
  const { error, warn } = console;
  console.error = () => undefined;
  console.warn = () => undefined;
  return run().finally(() => {
    console.error = error;
    console.warn = warn;
  });
}

describe('a replica store that refuses writes', () => {
  it('sends the edit anyway, never reports synced while it is unstored, and close() names the doc', async () => {
    const server = await TestServer.start();
    const store = new FlakyStore();
    const a = await connectedClient(server, store);
    const doc = await a.client.openDoc('pg:q');
    doc.getText('t').insert(0, 'seed ');
    await waitForConvergence(server, [store], ['pg:q']);

    store.failAppends = true;
    doc.getText('t').insert(5, 'typed while full');
    await waitFor(async () => contentOf(await server.storedDoc('pg:q')).t === 'seed typed while full', 'edit on server');
    expect(a.client.status).toMatchObject({ state: 'syncing', unstoredDocs: 1 });
    expect(a.client.status.lastError?.kind).toBe('store');

    // Leaving the page and a reconnect neither drop the edit nor clear the error.
    a.client.releaseDoc('pg:q');
    const back = nextState(a.client, 'offline').then(() => nextState(a.client, 'syncing'));
    a.control.cutAll();
    await back;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(a.client.status).toMatchObject({ state: 'syncing', unstoredDocs: 1 });
    expect(a.client.status.lastError?.kind).toBe('store');
    expect(contentOf(await a.client.openDoc('pg:q')).t).toBe('seed typed while full');
    a.client.releaseDoc('pg:q');

    await expect(a.client.close()).rejects.toThrow(/refused changes to 1 doc\(s\): pg:q/);
  });

  it('stores the edit once the store works again, then reports synced', async () => {
    const server = await TestServer.start();
    const store = new FlakyStore();
    const a = await connectedClient(server, store);
    store.failAppends = true;
    await editDoc(a.client, 'pg:r', (doc) => doc.getText('t').insert(0, 'kept'));
    await waitFor(() => a.client.status.unstoredDocs === 1, 'unstored doc counted');
    store.failAppends = false;
    await waitFor(() => a.client.status.unstoredDocs === 0, 'retry stored it', 5000);
    await waitForSynced(a.client);
    expect(a.client.status.lastError).toBeNull();
    expect(contentOf(await docFromStore(store, 'pg:r')).t).toBe('kept');
    await waitForConvergence(server, [store], ['pg:r']);
  });
});

describe('an unreadable doc', () => {
  it('on the server is set aside, the doc is restored from a client, and every other doc syncs', async () => {
    const server = await TestServer.start();
    const a = await connectedClient(server);
    for (const id of ['library', 'pg:bad', 'pg:good']) await editDoc(a.client, id, (doc) => doc.getText('t').insert(0, id));
    await waitForConvergence(server, [a.store], ['library', 'pg:bad', 'pg:good']);
    await server.stop();
    const folder = join(server.dataDir, 'docs', docFolderName('pg:bad'));
    const store = new DiskStore(server.dataDir);
    await store.compact('pg:bad');
    const snapshot = Y.encodeStateAsUpdate(await docFromStore(store, 'pg:bad'));
    await writeFile(join(folder, 'snapshot'), snapshot.subarray(0, snapshot.length - 5));
    await quietly(async () => {
      await server.startAgain();
      const b = await connectedClient(server);
      expect(b.client.status.failedDocs).toEqual([]);
      expect(contentOf(await docFromStore(b.store, 'pg:good')).t).toBe('pg:good');
      // A, still holding pg:bad, restores it on its reconnect.
      await waitForSynced(a.client);
      await waitForConvergence(server, [a.store, b.store], ['pg:bad']);
    });
    expect(contentOf(await server.storedDoc('pg:bad')).t).toBe('pg:bad');
    expect((await readdir(folder)).some((name) => name.startsWith('snapshot.corrupt-'))).toBe(true);
  });

  it('in a client store is skipped on load and filled from the server', async () => {
    const server = await TestServer.start();
    const a = await connectedClient(server);
    await editDoc(a.client, 'pg:x', (doc) => doc.getText('t').insert(0, 'from the server'));
    await waitForConvergence(server, [a.store], ['pg:x']);
    const store = new MemoryStore();
    await store.appendUpdate('pg:x', new Uint8Array([0xff, 0xff, 0xff]));
    const b = await connectedClient(server, store);
    expect(b.client.status.failedDocs).toEqual([]);
    expect(contentOf(await b.client.openDoc('pg:x')).t).toBe('from the server');
  });

  it('that the client store cannot read is recorded as failed while the rest syncs', async () => {
    const server = await TestServer.start();
    const a = await connectedClient(server);
    await editDoc(a.client, 'pg:broken', (doc) => doc.getText('t').insert(0, 'b'));
    await editDoc(a.client, 'pg:fine', (doc) => doc.getText('t').insert(0, 'f'));
    await waitForConvergence(server, [a.store], ['pg:broken', 'pg:fine']);
    const store = new FlakyStore();
    store.failReadsOf.add('pg:broken');
    const b = await connectedClient(server, store);
    expect(b.client.status.failedDocs).toEqual(['pg:broken']);
    expect(b.client.status.docsDone).toBe(b.client.status.docsTotal);
    expect(contentOf(await docFromStore(store, 'pg:fine')).t).toBe('f');
  });

  it('id too long to store is refused for that doc only, without reconnecting', async () => {
    const server = await TestServer.start();
    const control = new SocketControl();
    const a = await makeClient(new MemoryStore(), control, { docHandshakeTimeoutMs: 300 });
    const longId = `pg:${'x'.repeat(300)}`;
    await editDoc(a.client, longId, (doc) => doc.getText('t').insert(0, 'too long'));
    await editDoc(a.client, 'pg:short', (doc) => doc.getText('t').insert(0, 'short'));
    await quietly(async () => {
      await a.client.connect({ url: server.url, token: TOKEN });
      await waitFor(() => a.client.status.failedDocs.includes(longId), 'long id failed');
    });
    await waitForConvergence(server, [a.store], ['pg:short']);
    expect(control.sockets).toHaveLength(1);
  });
});

describe('updates the server cannot take whole', () => {
  it('keeps nothing of an update that fails part-way through applying', async () => {
    const server = await TestServer.start();
    const [full] = updatesOf((doc) => doc.getText('t').insert(0, 'PARTIAL'));
    const writer = await rawSocket(server);
    await quietly(async () => {
      sendFrame(writer.socket, FrameType.Update, 'pg:p', full!.subarray(0, full!.length - 1));
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    const reader = await rawSocket(server);
    sendFrame(reader.socket, FrameType.StateVector, 'pg:p', Y.encodeStateVector(new Y.Doc()));
    await waitFor(() => reader.frames.some((frame) => frame.type === FrameType.Diff), 'diff');
    const diff = reader.frames.find((frame) => frame.type === FrameType.Diff)!;
    const seen = new Y.Doc();
    Y.applyUpdate(seen, diff.payload);
    expect(seen.getText('t').toString()).toBe('');
    expect(await server.current.store.readUpdates('pg:p')).toEqual([]);
    expect(writer.closedWith()).toBeNull();
  });

  it('stores the part of an update that waits on a missing dependency', async () => {
    const server = await TestServer.start({ docCacheSize: 1 });
    const [first, second] = updatesOf((doc) => {
      doc.getText('t').insert(0, 'hello');
      doc.getText('t').insert(5, ' world');
    });
    const raw = await rawSocket(server);
    sendFrame(raw.socket, FrameType.Update, 'pg:x', second!);
    await waitFor(async () => (await server.current.store.readUpdates('pg:x')).length === 1, 'raw update stored');
    // Another doc pushes pg:x out of the one-doc cache.
    sendFrame(raw.socket, FrameType.StateVector, 'pg:other', Y.encodeStateVector(new Y.Doc()));
    await waitFor(() => raw.frames.some((frame) => frame.docId === 'pg:other'), 'other doc answered');
    sendFrame(raw.socket, FrameType.Update, 'pg:x', first!);
    await waitFor(async () => contentOf(await server.storedDoc('pg:x')).t === 'hello world', 'both parts stored');
    await server.stop();
    await server.startAgain();
    expect(contentOf(await server.storedDoc('pg:x')).t).toBe('hello world');
  });

  it('relays every stored update when compaction fails, and keeps the sender connected', async () => {
    const server = await TestServer.start();
    server.current.store.compact = async () => {
      throw new Error('ENOSPC');
    };
    const sender = await rawSocket(server);
    const listener = await rawSocket(server);
    const updates = updatesOf((doc) => {
      for (let i = 0; i < 205; i++) doc.getText('t').insert(0, 'x');
    });
    await quietly(async () => {
      for (const update of updates) sendFrame(sender.socket, FrameType.Update, 'pg:c', update);
      await waitFor(() => listener.frames.filter((frame) => frame.type === FrameType.Update).length === 205, 'all relayed');
    });
    expect(await server.current.store.readUpdates('pg:c')).toHaveLength(205);
    expect(sender.closedWith()).toBeNull();
  });
});

describe('two tabs on one replica store', () => {
  it('sends edits another tab stored, in the handshake Diff', async () => {
    const server = await TestServer.start();
    const shared = new MemoryStore();
    const tabA = await makeClient(shared, new SocketControl(), { tabChannel: null });
    const docA = await tabA.client.openDoc('pg:t');
    docA.getText('t').insert(0, 'A ');
    const tabB = await makeClient(shared, new SocketControl(), { tabChannel: null });
    await editDoc(tabB.client, 'pg:t', (doc) => doc.getText('t').insert(0, 'B offline '));
    await tabB.client.close();

    await tabA.client.connect({ url: server.url, token: TOKEN });
    await waitForSynced(tabA.client);
    await waitFor(async () => contentOf(await server.storedDoc('pg:t')).t.includes('B offline'), 'B edit on server');
    expect(docA.getText('t').toString()).toContain('B offline');
  });

  it('shows another tab\'s edit at once over the tab channel', async () => {
    const shared = new MemoryStore();
    const channel = `looseleaf-test-${Math.random()}`;
    const tabA = await makeClient(shared, new SocketControl(), { tabChannel: channel });
    const tabB = await makeClient(shared, new SocketControl(), { tabChannel: channel });
    const docA = await tabA.client.openDoc('pg:live');
    const docB = await tabB.client.openDoc('pg:live');
    docB.getText('t').insert(0, 'typed in B');
    await waitFor(() => docA.getText('t').toString() === 'typed in B', 'B edit in tab A');
    // Shown, not stored twice.
    expect(await shared.readUpdates('pg:live')).toHaveLength(1);
  });

  it('keeps both tabs\' unsent docs in the shared setting', async () => {
    const shared = new MemoryStore();
    const blocked = () => {
      const control = new SocketControl();
      control.blocked = true;
      return control;
    };
    const tabA = await makeClient(shared, blocked(), { tabChannel: null });
    const tabB = await makeClient(shared, blocked(), { tabChannel: null });
    await tabA.client.connect({ url: 'http://127.0.0.1:9', token: TOKEN });
    await tabB.client.connect({ url: 'http://127.0.0.1:9', token: TOKEN });
    await editDoc(tabA.client, 'pg:a', (doc) => doc.getText('t').insert(0, 'a'));
    await editDoc(tabB.client, 'pg:b', (doc) => doc.getText('t').insert(0, 'b'));
    await waitFor(() => tabA.client.status.unsentDocs === 1 && tabB.client.status.unsentDocs === 1, 'both counted');
    await tabA.client.close();
    await tabB.client.close();
    expect(JSON.parse((await shared.getSetting('unsentDocs'))!).sort()).toEqual(['pg:a', 'pg:b']);
  });
});

describe('blob uploads that fail', () => {
  it('retry on their own, and status is never synced while a blob is unsent', async () => {
    const server = await TestServer.start();
    let failuresLeft = 2;
    const flakyFetch: FetchLike = async (url, init) => {
      if (init?.method === 'PUT' && failuresLeft > 0) {
        failuresLeft -= 1;
        throw new Error('network down');
      }
      return nodeFetch(url, init);
    };
    const a = await connectedClient(server, new MemoryStore(), new SocketControl());
    await a.client.close();
    const b = await makeClient(new MemoryStore(), new SocketControl(), { fetch: flakyFetch });
    const seen: SyncStatus[] = [];
    b.client.onStatus((status) => seen.push(status));
    const hash = await b.client.putBlob(new TextEncoder().encode('a picture'));
    await b.client.connect({ url: server.url, token: TOKEN });
    await waitFor(() => b.client.status.state === 'synced' && b.client.status.unsentBlobs === 0, 'blob uploaded');
    expect(failuresLeft).toBe(0);
    expect(await server.current.store.hasBlob(hash)).toBe(true);
    expect(seen.some((status) => status.state === 'synced' && status.unsentBlobs > 0)).toBe(false);
    expect(seen.some((status) => status.lastError?.kind === 'blob')).toBe(true);
  });
});
