import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { openIndexedDbStore, type IdbFactory } from '../src/indexeddb-store.js';
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
