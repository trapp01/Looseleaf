import { rm } from 'node:fs/promises';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import {
  CLIENT_TOO_OLD_REASON,
  CLOSE_CLIENT_TOO_OLD,
  CLOSE_PROTOCOL_ERROR,
  CONTENT_VERSION,
  decodeFrame,
  FrameType,
  HANDSHAKE_CONCURRENCY,
  MemoryStore,
  openIndexedDbStore,
  type IdbFactory,
  type SyncStatus,
} from '@looseleaf/sync';
import {
  connectedClient,
  contentOf,
  docFromStore,
  editDoc,
  makeClient,
  nextState,
  SocketControl,
  TestServer,
  TOKEN,
  waitFor,
  waitForConvergence,
  waitForSynced,
} from './harness.js';

describe('two replicas editing apart', () => {
  it.each(['A', 'B'])('converge with both edits whichever reconnects first (%s first)', async (first) => {
    const server = await TestServer.start();
    const a = await makeClient();
    const b = await makeClient();
    await editDoc(a.client, 'pg:shared', (doc) => {
      doc.getText('t').insert(0, 'alpha ');
      doc.getMap('m').set('fromA', 1);
    });
    await editDoc(b.client, 'pg:shared', (doc) => {
      doc.getText('t').insert(0, 'beta ');
      doc.getMap('m').set('fromB', 2);
    });
    await editDoc(a.client, 'library', (doc) => doc.getMap('m').set('nb', 'A'));
    await editDoc(b.client, 'library', (doc) => doc.getMap('m').set('nb', 'B'));
    const order = first === 'A' ? [a, b] : [b, a];
    for (const { client } of order) await client.connect({ url: server.url, token: TOKEN });
    await Promise.all(order.map(({ client }) => waitForSynced(client)));

    const states = await waitForConvergence(server, [a.store, b.store], ['pg:shared', 'library']);
    const page = contentOf(states.get('pg:shared')!);
    expect(page.t).toContain('alpha ');
    expect(page.t).toContain('beta ');
    expect(page.m).toEqual({ fromA: 1, fromB: 2 });
    // One field set on both sides keeps exactly one of the two values.
    expect(['A', 'B']).toContain(contentOf(states.get('library')!).m.nb);
    // The live docs agree with the stores.
    const liveA = await a.client.openDoc('pg:shared');
    const liveB = await b.client.openDoc('pg:shared');
    expect(contentOf(liveA)).toEqual(page);
    expect(contentOf(liveB)).toEqual(page);
  });

  it('converges with both edits while listeners for stored docs run, one of which throws', async () => {
    const server = await TestServer.start();
    const a = await makeClient();
    const b = await makeClient();
    const heardByA: string[] = [];
    const heardByB: string[] = [];
    a.client.onDocStored(() => {
      throw new Error('a listener that fails');
    });
    a.client.onDocStored((docId) => heardByA.push(docId));
    b.client.onDocStored((docId) => heardByB.push(docId));
    await editDoc(a.client, 'pg:shared', (doc) => doc.getText('t').insert(0, 'alpha '));
    await editDoc(b.client, 'pg:shared', (doc) => doc.getText('t').insert(0, 'beta '));
    await editDoc(a.client, 'pg:onlyA', (doc) => doc.getText('t').insert(0, 'made on A'));
    heardByB.length = 0;
    for (const { client } of [a, b]) await client.connect({ url: server.url, token: TOKEN });
    await Promise.all([a, b].map(({ client }) => waitForSynced(client)));

    const states = await waitForConvergence(server, [a.store, b.store], ['pg:shared', 'pg:onlyA']);
    const text = contentOf(states.get('pg:shared')!).t;
    expect(text).toContain('alpha ');
    expect(text).toContain('beta ');
    // B is told about the doc it never opened and about the edit A made to the shared one.
    expect(heardByB).toContain('pg:onlyA');
    expect(heardByB).toContain('pg:shared');
    expect(heardByA).toContain('pg:shared');
  });

  it('forwards live edits between connected replicas', async () => {
    const server = await TestServer.start();
    const a = await connectedClient(server);
    const b = await connectedClient(server);
    const docA = await a.client.openDoc('pg:live');
    const docB = await b.client.openDoc('pg:live');
    docA.getText('t').insert(0, 'typed on A');
    await waitFor(() => docB.getText('t').toString() === 'typed on A', 'live edit on B');
    docB.getText('t').insert(docB.getText('t').length, ', then B');
    await waitFor(() => docA.getText('t').toString() === 'typed on A, then B', 'live edit on A');
    await waitForConvergence(server, [a.store, b.store], ['pg:live']);
  });
});

describe('recovering from loss', () => {
  it('sends edits made offline before a crash once a new client starts on the same store', async () => {
    const server = await TestServer.start();
    const a = await connectedClient(server);
    a.control.blocked = true;
    a.control.cutAll();
    await waitFor(() => a.client.status.state === 'offline', 'A offline');
    await editDoc(a.client, 'pg:offline', (doc) => doc.getText('t').insert(0, 'written offline'));
    await waitFor(() => a.client.status.unsentDocs === 1, 'A counts the unsent doc');
    // The process dies: the client goes away without another chance to send.
    await a.client.close();
    expect(await server.current.store.listDocs()).not.toContain('pg:offline');

    const restarted = await makeClient(a.store);
    expect(restarted.client.status.unsentDocs).toBe(1);
    await waitForSynced(restarted.client);
    expect(restarted.client.status.unsentDocs).toBe(0);
    const b = await connectedClient(server);
    const states = await waitForConvergence(server, [a.store, b.store], ['pg:offline']);
    expect(contentOf(states.get('pg:offline')!).t).toBe('written offline');
  });

  it('restores a wiped server from a client, and a fresh client then receives everything', async () => {
    const server = await TestServer.start();
    const a = await connectedClient(server);
    const ids = ['library', 'nb:one', 'pg:one', 'pg:two'];
    for (const id of ids) await editDoc(a.client, id, (doc) => doc.getText('t').insert(0, `content of ${id}`));
    const hash = await a.client.putBlob(new TextEncoder().encode('a picture'));
    await waitForConvergence(server, [a.store], ids);
    await waitFor(() => a.client.status.unsentBlobs === 0, 'blob uploaded');

    await server.stop();
    await rm(server.dataDir, { recursive: true, force: true });
    await server.startAgain();
    await waitFor(async () => (await server.current.store.listDocs()).length === ids.length, 'server restored');
    await waitFor(() => server.current.store.hasBlob(hash), 'blob restored');
    await waitForSynced(a.client);

    const fresh = await connectedClient(server);
    const states = await waitForConvergence(server, [a.store, fresh.store], ids);
    for (const id of ids) expect(contentOf(states.get(id)!).t).toBe(`content of ${id}`);
    expect(await fresh.client.getBlob(hash)).toEqual(new TextEncoder().encode('a picture'));
    expect(await fresh.store.hasBlob(hash)).toBe(true);
  });

  it('restores a wiped client store from the server', async () => {
    const server = await TestServer.start();
    const a = await connectedClient(server);
    await editDoc(a.client, 'pg:keep', (doc) => doc.getMap('m').set('k', 'v'));
    const hash = await a.client.putBlob(new Uint8Array([1, 2, 3]));
    await waitForConvergence(server, [a.store], ['pg:keep']);
    await waitFor(() => a.client.status.unsentBlobs === 0, 'blob uploaded');
    await a.client.close();

    const wiped = await connectedClient(server, new MemoryStore());
    await waitForConvergence(server, [wiped.store], ['pg:keep']);
    expect(contentOf(await docFromStore(wiped.store, 'pg:keep')).m).toEqual({ k: 'v' });
    expect(await wiped.store.hasBlob(hash)).toBe(true);
  });
});

describe('docs a replica has not opened', () => {
  it('delivers a doc created on A into B\'s store while B is connected, without B asking', async () => {
    const server = await TestServer.start();
    const a = await connectedClient(server);
    const b = await connectedClient(server);
    await editDoc(a.client, 'pg:new', (doc) => doc.getText('t').insert(0, 'made on A'));
    await waitFor(async () => (await b.store.listDocs()).includes('pg:new'), 'pg:new in B store');
    await waitForConvergence(server, [a.store, b.store], ['pg:new']);
    expect(contentOf(await docFromStore(b.store, 'pg:new')).t).toBe('made on A');
  });

  it('syncs docs that are only in the store, both ways', async () => {
    const server = await TestServer.start();
    const aStore = new MemoryStore();
    const writer = await makeClient(aStore);
    for (let i = 0; i < 5; i++) await editDoc(writer.client, `pg:a${i}`, (doc) => doc.getText('t').insert(0, `a${i}`));
    await writer.client.close();
    const b = await connectedClient(server);
    for (let i = 0; i < 5; i++) await editDoc(b.client, `pg:b${i}`, (doc) => doc.getText('t').insert(0, `b${i}`));
    await waitForConvergence(server, [b.store], ['pg:b0', 'pg:b4']);

    const a = await connectedClient(server, aStore);
    const ids = [...Array.from({ length: 5 }, (_, i) => `pg:a${i}`), ...Array.from({ length: 5 }, (_, i) => `pg:b${i}`)];
    const states = await waitForConvergence(server, [a.store, b.store], ids);
    expect(contentOf(states.get('pg:a3')!).t).toBe('a3');
    expect(contentOf(states.get('pg:b2')!).t).toBe('b2');
  });
});

describe('cut connections', () => {
  it('converges after the socket is cut in the middle of the handshake', async () => {
    const server = await TestServer.start();
    const b = await connectedClient(server);
    for (let i = 0; i < 40; i++) await editDoc(b.client, `pg:b${i}`, (doc) => doc.getText('t').insert(0, `b${i}`));
    const store = new MemoryStore();
    const writer = await makeClient(store);
    for (let i = 0; i < 40; i++) await editDoc(writer.client, `pg:a${i}`, (doc) => doc.getText('t').insert(0, `a${i}`));
    await writer.client.close();

    const control = new SocketControl();
    let binaryFramesSent = 0;
    let cuts = 0;
    control.events.sent = (data) => {
      if (typeof data === 'string') return;
      binaryFramesSent += 1;
      // Cut twice: once among the first state vectors, once among the Diffs.
      if ((cuts === 0 && binaryFramesSent === 5) || (cuts === 1 && binaryFramesSent === 30)) {
        cuts += 1;
        binaryFramesSent = 0;
        setImmediate(() => control.cutAll());
      }
    };
    const a = await makeClient(store, control);
    await a.client.connect({ url: server.url, token: TOKEN });
    await waitFor(() => cuts === 2, 'two cuts');
    await waitForSynced(a.client);
    const ids = Array.from({ length: 40 }, (_, i) => [`pg:a${i}`, `pg:b${i}`]).flat();
    await waitForConvergence(server, [a.store, b.store], ids);
  });

  it('converges after the socket is cut during a stream of live updates', async () => {
    const server = await TestServer.start();
    const a = await connectedClient(server);
    const b = await connectedClient(server);
    const docA = await a.client.openDoc('pg:stream');
    const docB = await b.client.openDoc('pg:stream');
    for (let i = 0; i < 200; i++) {
      docA.getText('t').insert(docA.getText('t').length, 'a');
      if (i % 3 === 0) docB.getMap('m').set(`k${i}`, i);
      if (i === 60) a.control.cutAll();
      if (i === 120) b.control.cutAll();
      await new Promise((resolve) => setImmediate(resolve));
    }
    await Promise.all([waitForSynced(a.client), waitForSynced(b.client)]);
    const states = await waitForConvergence(server, [a.store, b.store], ['pg:stream']);
    expect(contentOf(states.get('pg:stream')!).t).toBe('a'.repeat(200));
    expect(Object.keys(contentOf(states.get('pg:stream')!).m)).toHaveLength(67);
    expect(contentOf(docA)).toEqual(contentOf(docB));
  });

  it('reconnects after a server restart and stays converged', async () => {
    const server = await TestServer.start();
    const a = await connectedClient(server);
    const b = await connectedClient(server);
    const docB = await b.client.openDoc('pg:restart');
    await editDoc(a.client, 'pg:restart', (doc) => doc.getText('t').insert(0, 'before '));
    await waitFor(() => docB.getText('t').toString() === 'before ', 'first edit on B');

    const offline = Promise.all([nextState(a.client, 'offline'), nextState(b.client, 'offline')]);
    await server.stop();
    await offline;
    await editDoc(a.client, 'pg:restart', (doc) => doc.getText('t').insert(7, 'during'));
    await server.startAgain();
    await Promise.all([waitForSynced(a.client), waitForSynced(b.client)]);
    await waitFor(() => docB.getText('t').toString() === 'before during', 'offline edit on B');
    await editDoc(b.client, 'pg:restart', (doc) => doc.getText('t').insert(0, '[after] '));
    const states = await waitForConvergence(server, [a.store, b.store], ['pg:restart']);
    expect(contentOf(states.get('pg:restart')!).t).toBe('[after] before during');
  });
});

describe('access token', () => {
  it('reports a bad token apart from an unreachable server and sends nothing until it is fixed', async () => {
    const server = await TestServer.start();
    const a = await makeClient();
    await editDoc(a.client, 'pg:secret', (doc) => doc.getText('t').insert(0, 'private'));
    await a.client.putBlob(new Uint8Array([4, 5, 6]));
    await a.client.connect({ url: server.url, token: 'wrong' });
    await waitFor(() => a.client.status.lastError?.kind === 'bad-token', 'bad-token status');
    expect(a.client.status.state).toBe('offline');
    expect(a.client.status.nextRetryAt).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await server.current.store.listDocs()).toEqual([]);
    expect(await server.current.store.listBlobs()).toEqual([]);

    const unreachable = await makeClient();
    await unreachable.client.connect({ url: 'http://127.0.0.1:9', token: TOKEN });
    await waitFor(() => unreachable.client.status.lastError?.kind === 'unreachable', 'unreachable status');

    await a.client.connect({ url: server.url, token: TOKEN });
    await waitForSynced(a.client);
    expect(a.client.status.lastError).toBeNull();
    await waitForConvergence(server, [a.store], ['pg:secret']);
    await waitFor(async () => (await server.current.store.listBlobs()).length === 1, 'blob uploaded');
  });
});

describe('content version', () => {
  /** Sends a hello and resolves with the close code and reason, and whether any frame came back first. */
  async function helloAndClose(server: TestServer, hello: object): Promise<{ code: number; reason: string; answered: boolean }> {
    const socket = new WebSocket(server.url.replace('http', 'ws') + '/sync');
    let answered = false;
    socket.on('message', () => {
      answered = true;
    });
    await new Promise((resolve) => socket.once('open', resolve));
    socket.send(JSON.stringify(hello));
    return new Promise((resolve) => {
      socket.once('close', (code, reason) => resolve({ code, reason: reason.toString(), answered }));
    });
  }

  it('refuses an app older than the server before any doc is exchanged, with a code each build understands', async () => {
    const server = await TestServer.start();
    const a = await connectedClient(server);
    await editDoc(a.client, 'pg:shared', (doc) => doc.getText('t').insert(0, 'on the server'));
    await waitForConvergence(server, [a.store], ['pg:shared']);

    // Builds that send no content version.
    const field = await helloAndClose(server, { t: 'hello', token: TOKEN, replica: 'old', v: 1 });
    expect(field).toEqual({ code: CLOSE_PROTOCOL_ERROR, reason: CLIENT_TOO_OLD_REASON, answered: false });
    const versioned = await helloAndClose(server, { t: 'hello', token: TOKEN, replica: 'old', v: 1, content: CONTENT_VERSION - 1 });
    expect(versioned).toEqual({ code: CLOSE_CLIENT_TOO_OLD, reason: CLIENT_TOO_OLD_REASON, answered: false });
    // A newer app than the server syncs.
    const newer = new WebSocket(server.url.replace('http', 'ws') + '/sync');
    await new Promise((resolve) => newer.once('open', resolve));
    newer.send(JSON.stringify({ t: 'hello', token: TOKEN, replica: 'new', v: 1, content: CONTENT_VERSION + 1 }));
    const welcome = await new Promise<string>((resolve) => newer.once('message', (data) => resolve(String(data))));
    expect(JSON.parse(welcome).docs).toContain('pg:shared');
    newer.terminate();
  });
});

describe('blobs', () => {
  it('mirrors blobs both ways and fetches a missing blob on demand', async () => {
    const server = await TestServer.start();
    const a = await makeClient();
    const offlineHash = await a.client.putBlob(new TextEncoder().encode('made offline'));
    await a.client.connect({ url: server.url, token: TOKEN });
    await waitForSynced(a.client);
    await waitFor(() => server.current.store.hasBlob(offlineHash), 'offline blob uploaded');
    const onlineHash = await a.client.putBlob(new TextEncoder().encode('made online'));
    await waitFor(() => server.current.store.hasBlob(onlineHash), 'online blob uploaded');
    await waitFor(() => a.client.status.unsentBlobs === 0, 'no unsent blobs on A');

    const b = await makeClient();
    const bOnly = await b.client.putBlob(new TextEncoder().encode('from B'));
    await b.client.connect({ url: server.url, token: TOKEN });
    await waitForSynced(b.client);
    expect((await b.store.listBlobs()).sort()).toEqual([offlineHash, onlineHash, bOnly].sort());
    await waitFor(() => server.current.store.hasBlob(bOnly), 'B blob uploaded');

    // A replica that is configured but not connected fetches a blob it lacks on demand.
    const control = new SocketControl();
    control.blocked = true;
    const c = await makeClient(new MemoryStore(), control);
    await c.client.connect({ url: server.url, token: TOKEN });
    expect(await c.store.hasBlob(bOnly)).toBe(false);
    expect(await c.client.getBlob(bOnly)).toEqual(new TextEncoder().encode('from B'));
    expect(await c.store.hasBlob(bOnly)).toBe(true);
    expect(await c.client.getBlob('0'.repeat(64))).toBeNull();
  });
});

describe('many docs', () => {
  it('syncs 300 docs at bounded concurrency and reports progress until synced', async () => {
    const server = await TestServer.start({ docCacheSize: 50 });
    const store = new MemoryStore();
    const writer = await makeClient(store);
    const ids = ['library', ...Array.from({ length: 299 }, (_, i) => `pg:${i}`)];
    for (const id of ids) await editDoc(writer.client, id, (doc) => doc.getText('t').insert(0, id));
    await writer.client.close();

    const control = new SocketControl();
    const outstanding = new Set<string>();
    let maxOutstanding = 0;
    const startOrder: string[] = [];
    control.events.sent = (data) => {
      if (typeof data === 'string') return;
      const frame = decodeFrame(data);
      if (frame.type !== FrameType.StateVector) return;
      startOrder.push(frame.docId);
      outstanding.add(frame.docId);
      maxOutstanding = Math.max(maxOutstanding, outstanding.size);
    };
    control.events.received = (data, isBinary) => {
      if (!isBinary) return;
      const frame = decodeFrame(data);
      if (frame.type === FrameType.StateVector) outstanding.delete(frame.docId);
    };
    const a = await makeClient(store, control);
    const seen: SyncStatus[] = [];
    a.client.onStatus((status) => seen.push(status));
    a.client.setPriorityDoc('pg:150');
    await a.client.connect({ url: server.url, token: TOKEN });
    await waitForSynced(a.client, 20_000);

    // The library first, then the page the UI named, then the rest.
    expect(startOrder.slice(0, 2)).toEqual(['library', 'pg:150']);
    expect(maxOutstanding).toBeGreaterThan(1);
    expect(maxOutstanding).toBeLessThanOrEqual(HANDSHAKE_CONCURRENCY);
    expect(a.client.status).toMatchObject({ state: 'synced', docsDone: 300, docsTotal: 300 });
    const syncing = seen.filter((status) => status.state === 'syncing');
    expect(syncing.some((status) => status.docsDone > 0 && status.docsDone < 300)).toBe(true);
    expect(server.current.hub.loadedDocCount).toBeLessThanOrEqual(50 + HANDSHAKE_CONCURRENCY);

    // A counts a doc done once its Diff is sent; wait for the server to store the last ones.
    await waitFor(async () => (await server.current.store.listDocs()).length === 300, 'server holds 300 docs');
    const b = await connectedClient(server);
    expect(b.client.status.docsTotal).toBe(300);
    expect((await b.store.listDocs()).length).toBe(300);
    await waitForConvergence(server, [a.store, b.store], ['library', 'pg:0', 'pg:150', 'pg:298']);
    expect(contentOf(await docFromStore(b.store, 'pg:298')).t).toBe('pg:298');
  }, 30_000);
});

describe('server data folder', () => {
  it('stores what the doc did not already have, so repeated handshakes do not grow the log', async () => {
    const server = await TestServer.start();
    const a = await connectedClient(server);
    await editDoc(a.client, 'pg:x', (doc) => doc.getText('t').insert(0, 'once'));
    await waitForConvergence(server, [a.store], ['pg:x']);
    const before = (await server.current.store.readUpdates('pg:x')).length;
    for (let i = 0; i < 3; i++) {
      const offline = nextState(a.client, 'offline');
      const synced = offline.then(() => nextState(a.client, 'synced'));
      a.control.cutAll();
      await synced;
    }
    expect((await server.current.store.readUpdates('pg:x')).length).toBe(before);
    expect(contentOf(await server.storedDoc('pg:x')).t).toBe('once');
  });
});

describe('IndexedDB replicas', () => {
  it('converge through the server and keep offline edits across a crash', async () => {
    const server = await TestServer.start();
    const factory = new IDBFactory() as unknown as IdbFactory;
    const a = await makeClient(await openIndexedDbStore('device-a', factory));
    const b = await makeClient(await openIndexedDbStore('device-b', factory));
    await editDoc(a.client, 'pg:idb', (doc) => doc.getText('t').insert(0, 'from A '));
    await editDoc(b.client, 'pg:idb', (doc) => doc.getMap('m').set('b', true));
    await a.client.close();

    const restartedA = await makeClient(await openIndexedDbStore('device-a', factory));
    await restartedA.client.connect({ url: server.url, token: TOKEN });
    await b.client.connect({ url: server.url, token: TOKEN });
    await Promise.all([waitForSynced(restartedA.client), waitForSynced(b.client)]);
    const states = await waitForConvergence(server, [restartedA.store, b.store], ['pg:idb']);
    expect(contentOf(states.get('pg:idb')!)).toEqual({ t: 'from A ', m: { b: true } });
  });
});
