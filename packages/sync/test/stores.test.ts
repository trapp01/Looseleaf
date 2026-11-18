import { IDBDatabase, IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { DATABASE_VERSION, NEWER_BUILD_MESSAGE, openIndexedDbStore, type IdbFactory } from '../src/indexeddb-store.js';
import { MemoryStore, type ClientStore } from '../src/replica-store.js';
import { describeReplicaStore } from './replica-store-suite.js';

let databaseCount = 0;

async function openFakeIndexedDb(): Promise<{ store: ClientStore; reopen: () => Promise<ClientStore> }> {
  const factory = new IDBFactory() as unknown as IdbFactory;
  const name = `looseleaf-test-${(databaseCount += 1)}`;
  const store = await openIndexedDbStore(name, factory);
  return {
    store,
    reopen: async () => {
      store.close();
      return openIndexedDbStore(name, factory);
    },
  };
}

describeReplicaStore('memory', async () => ({ store: new MemoryStore() }));
describeReplicaStore('IndexedDB', openFakeIndexedDb);

describe.each([
  ['memory', async () => ({ store: new MemoryStore() as ClientStore, reopen: undefined })],
  ['IndexedDB', openFakeIndexedDb],
] as const)('%s settings', (_name, open) => {
  it('reads back, overwrites and removes a setting', async () => {
    const { store } = await open();
    expect(await store.getSetting('serverAddress')).toBeNull();
    await store.setSetting('serverAddress', 'http://nas:8421');
    await store.setSetting('serverAddress', 'http://nas:9000');
    expect(await store.getSetting('serverAddress')).toBe('http://nas:9000');
    await store.setSetting('serverAddress', null);
    expect(await store.getSetting('serverAddress')).toBeNull();
  });

  it('applies concurrent updates of one setting one after another', async () => {
    const { store } = await open();
    const append = (suffix: string) => store.updateSetting('list', (value) => `${value ?? ''}${suffix}`);
    await Promise.all([append('a'), append('b'), append('c')]);
    expect((await store.getSetting('list'))?.split('').sort()).toEqual(['a', 'b', 'c']);
    await store.updateSetting('list', () => null);
    expect(await store.getSetting('list')).toBeNull();
  });
});

describe('IndexedDB store', () => {
  it('keeps settings across a reopen', async () => {
    const { store, reopen } = await openFakeIndexedDb();
    await store.setSetting('replicaId', 'abc');
    expect(await (await reopen()).getSetting('replicaId')).toBe('abc');
  });

  it('fails with a descriptive error when no IndexedDB exists', async () => {
    await expect(openIndexedDbStore('x', undefined)).rejects.toThrow(/IndexedDB is not available/);
  });
});

/** Opens the database as builds without a content version do: version 1, closing the connection when another tab asks. */
function openAsOlderBuild(factory: InstanceType<typeof IDBFactory>, name: string): Promise<InstanceType<typeof IDBDatabase>> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore('updates', { autoIncrement: true }).createIndex('docId', 'docId');
      db.createObjectStore('blobs');
      db.createObjectStore('settings');
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => reject(request.error);
  });
}

function done(tx: { oncomplete: unknown; onerror: unknown }): Promise<void> {
  return new Promise((resolve, reject) => Object.assign(tx, { oncomplete: () => resolve(), onerror: () => reject(new Error('transaction failed')) }));
}

describe('IndexedDB across builds', () => {
  it('a tab of this build takes the database from an older build’s tab, keeping everything it stored', async () => {
    const factory = new IDBFactory();
    const name = `looseleaf-builds-${(databaseCount += 1)}`;
    const older = await openAsOlderBuild(factory, name);
    const tx = older.transaction(['updates', 'blobs', 'settings'], 'readwrite');
    tx.objectStore('updates').add({ docId: 'pg:a', update: new Uint8Array([1, 2, 3]) });
    tx.objectStore('blobs').put(new Uint8Array([9]), 'hash-1');
    tx.objectStore('settings').put('http://nas:8421', 'serverAddress');
    await done(tx);

    const store = await openIndexedDbStore(name, factory as unknown as IdbFactory);
    expect(await store.readUpdates('pg:a')).toEqual([new Uint8Array([1, 2, 3])]);
    expect(await store.getBlob('hash-1')).toEqual(new Uint8Array([9]));
    expect(await store.getSetting('serverAddress')).toBe('http://nas:8421');
    // The older tab's connection is closed and the older build cannot open the database again.
    expect(() => older.transaction(['updates'], 'readonly')).toThrow();
    await expect(openAsOlderBuild(factory, name)).rejects.toBeDefined();

    // Two tabs of this build share it.
    const second = await openIndexedDbStore(name, factory as unknown as IdbFactory);
    await store.appendUpdate('pg:b', new Uint8Array([4]));
    expect(await second.readUpdates('pg:b')).toEqual([new Uint8Array([4])]);
  });

  it('stops storing, with a sentence saying to reload, once a tab of a newer build opens the database', async () => {
    const factory = new IDBFactory();
    const name = `looseleaf-builds-${(databaseCount += 1)}`;
    const store = await openIndexedDbStore(name, factory as unknown as IdbFactory);
    await new Promise((resolve, reject) => {
      const request = factory.open(name, DATABASE_VERSION + 1);
      request.onsuccess = resolve;
      request.onerror = reject;
    });
    await expect(store.appendUpdate('pg:a', new Uint8Array([1]))).rejects.toThrow(NEWER_BUILD_MESSAGE);
  });
});
