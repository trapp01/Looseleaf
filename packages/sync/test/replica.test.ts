import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { PersistedIdSet } from '../src/persisted-id-set.js';
import { Replica, type ReplicaEvents } from '../src/replica.js';
import { MemoryStore } from '../src/replica-store.js';
import { captureUpdates } from './replica-store-suite.js';

function recordingEvents(): ReplicaEvents & { sent: Uint8Array[]; errors: string[]; stored: string[] } {
  const sent: Uint8Array[] = [];
  const errors: string[] = [];
  const stored: string[] = [];
  return {
    sent,
    errors,
    stored,
    onLocalChange: (_docId, update) => sent.push(update),
    onStoreError: (error) => errors.push(error.message),
    onCountsChange: () => undefined,
    onStored: (docId) => stored.push(docId),
  };
}

class RefusingStore extends MemoryStore {
  refuse = false;
  override async appendUpdate(docId: string, update: Uint8Array): Promise<void> {
    if (this.refuse) throw new Error('QuotaExceededError');
    return super.appendUpdate(docId, update);
  }
}

describe('Replica', () => {
  it('refuses a remote update that does not decode and stores nothing', async () => {
    const store = new MemoryStore();
    const replica = await Replica.create(store, recordingEvents());
    await expect(replica.applyRemote('pg:z', new Uint8Array([0xff, 0xff, 0xff]))).rejects.toThrow(/does not decode/);
    expect(await store.listDocs()).toEqual([]);
    await replica.open('pg:z');
  });

  it('keeps a remote update that waits on a missing dependency, received while the doc is open', async () => {
    const store = new MemoryStore();
    const [base, dependent] = captureUpdates(new Y.Doc(), (doc) => {
      doc.getText('t').insert(0, 'base');
      doc.getText('t').insert(4, '+dependent');
    });
    const first = await Replica.create(store, recordingEvents());
    await first.open('pg:p');
    await first.applyRemote('pg:p', dependent!);
    await first.close();
    const second = await Replica.create(store, recordingEvents());
    const doc = await second.open('pg:p');
    Y.applyUpdate(doc, base!);
    expect(doc.getText('t').toString()).toBe('base+dependent');
  });

  it('sends a change an observer makes in reaction to a remote update, without echoing the remote one', async () => {
    const events = recordingEvents();
    const replica = await Replica.create(new MemoryStore(), events);
    const doc = await replica.open('pg:o');
    doc.getText('t').observe(() => doc.getMap('m').set('seen', doc.getText('t').length));
    const remote = new Y.Doc();
    remote.getText('t').insert(0, 'remote');
    await replica.applyRemote('pg:o', Y.encodeStateAsUpdate(remote));
    await new Promise((resolve) => setTimeout(resolve, 10));
    const sent = new Y.Doc();
    for (const update of events.sent) Y.applyUpdate(sent, update);
    expect(sent.getMap('m').get('seen')).toBe(6);
    expect(sent.getText('t').toString()).toBe('');
  });

  it('hands on a change the store refuses, keeps the doc loaded, and close() names it', async () => {
    const store = new RefusingStore();
    const events = recordingEvents();
    const replica = await Replica.create(store, events);
    const doc = await replica.open('pg:f');
    store.refuse = true;
    doc.getText('t').insert(0, 'unstored');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(events.sent).toHaveLength(1);
    expect(replica.unstoredCount()).toBe(1);
    replica.release('pg:f');
    expect(await replica.open('pg:f')).toBe(doc);
    replica.release('pg:f');
    await expect(replica.close()).rejects.toThrow(/pg:f/);
    expect(doc.getText('t').toString()).toBe('unstored');
  });
});

describe('Replica onStored', () => {
  it('reports local changes and remote updates to loaded and unloaded docs once they are stored', async () => {
    const store = new MemoryStore();
    const events = recordingEvents();
    const replica = await Replica.create(store, events);
    const doc = await replica.open('pg:open');
    doc.getText('t').insert(0, 'typed here');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(events.stored).toEqual(['pg:open']);

    const remote = new Y.Doc();
    remote.getText('t').insert(0, 'from the server');
    await replica.applyRemote('pg:open', Y.encodeStateAsUpdate(remote));
    await replica.applyRemote('pg:closed', Y.encodeStateAsUpdate(remote));
    expect(events.stored).toEqual(['pg:open', 'pg:open', 'pg:closed']);
    expect(await store.readUpdates('pg:closed')).toHaveLength(1);
  });

  it('does not report a change the store refuses until a retry stores it', async () => {
    const store = new RefusingStore();
    const events = recordingEvents();
    const replica = await Replica.create(store, events);
    const doc = await replica.open('pg:f');
    store.refuse = true;
    doc.getText('t').insert(0, 'unstored');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(events.stored).toEqual([]);
    store.refuse = false;
    await replica.flush();
    expect(events.stored).toEqual(['pg:f']);
  });
});

describe('PersistedIdSet', () => {
  it('merges two tabs\' changes instead of overwriting', async () => {
    const store = new MemoryStore();
    const onError = (error: Error) => {
      throw error;
    };
    const tabA = await PersistedIdSet.load(store, 'unsentDocs', onError);
    const tabB = await PersistedIdSet.load(store, 'unsentDocs', onError);
    tabA.add('pg:a');
    tabB.add('pg:b');
    await Promise.all([tabA.flushed(), tabB.flushed()]);
    expect(JSON.parse((await store.getSetting('unsentDocs'))!).sort()).toEqual(['pg:a', 'pg:b']);
    tabB.delete('pg:b');
    await tabB.flushed();
    expect(JSON.parse((await store.getSetting('unsentDocs'))!)).toEqual(['pg:a']);
  });

  it('reads a damaged setting as empty and reports it', async () => {
    const store = new MemoryStore();
    await store.setSetting('unsentDocs', '{oops');
    const errors: string[] = [];
    const set = await PersistedIdSet.load(store, 'unsentDocs', (error) => errors.push(error.message));
    expect(set.size).toBe(0);
    expect(errors[0]).toMatch(/reading it as empty/);
  });
});
