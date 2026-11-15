/**
 * The behaviour every ReplicaStore implementation shares, written once and
 * run against each one: memory and IndexedDB here, disk in packages/server.
 * Imported by other packages as `@looseleaf/sync/testing`.
 */
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { blobHash, type ReplicaStore } from '../src/replica-store.js';

export interface StoreFixture {
  store: ReplicaStore;
  /** Opens the same storage again, as a restarted process would. Omit for stores that live only in memory. */
  reopen?: () => Promise<ReplicaStore>;
}

/** Records every update a doc emits while `edit` runs on it. */
export function captureUpdates(doc: Y.Doc, edit: (doc: Y.Doc) => void): Uint8Array[] {
  const updates: Uint8Array[] = [];
  const onUpdate = (update: Uint8Array) => updates.push(update);
  doc.on('update', onUpdate);
  edit(doc);
  doc.off('update', onUpdate);
  return updates;
}

/** The text of `doc.getText('t')` after applying every update to a fresh doc. */
export function textOf(updates: Uint8Array[]): string {
  const doc = new Y.Doc();
  for (const update of updates) Y.applyUpdate(doc, update);
  return doc.getText('t').toString();
}

function typingUpdates(text: string, doc = new Y.Doc()): Uint8Array[] {
  return captureUpdates(doc, (d) => {
    for (const char of text) d.getText('t').insert(d.getText('t').length, char);
  });
}

export function describeReplicaStore(name: string, open: () => Promise<StoreFixture>): void {
  describe(`${name} replica store`, () => {
    it('starts empty', async () => {
      const { store } = await open();
      expect(await store.listDocs()).toEqual([]);
      expect(await store.readUpdates('library')).toEqual([]);
      expect(await store.listBlobs()).toEqual([]);
      expect(await store.getBlob(blobHash(new Uint8Array([1])))).toBeNull();
    });

    it('returns appended updates in order and lists the doc', async () => {
      const { store } = await open();
      const updates = typingUpdates('hello');
      for (const update of updates) await store.appendUpdate('pg:a', update);
      const stored = await store.readUpdates('pg:a');
      expect(stored.map((u) => [...u])).toEqual(updates.map((u) => [...u]));
      expect(textOf(stored)).toBe('hello');
      expect(await store.listDocs()).toEqual(['pg:a']);
    });

    it('keeps docs apart, including ids with characters that are unsafe in file names', async () => {
      const { store } = await open();
      const ids = ['library', 'nb:Ab_9-x', 'pg:../../etc', 'pg:a/b\\c%2F', 'pg:ÄÖ ü', 'pg:AB', 'pg:ab', '.'];
      for (const [index, id] of ids.entries()) {
        for (const update of typingUpdates(`doc${index}`)) await store.appendUpdate(id, update);
      }
      expect([...(await store.listDocs())].sort()).toEqual([...ids].sort());
      for (const [index, id] of ids.entries()) {
        expect(textOf(await store.readUpdates(id))).toBe(`doc${index}`);
      }
    });

    it('compacts a doc into one update with the same content, and keeps appending after', async () => {
      const { store } = await open();
      const doc = new Y.Doc();
      for (const update of typingUpdates('abc', doc)) await store.appendUpdate('pg:c', update);
      await store.compact('pg:c');
      expect(await store.readUpdates('pg:c')).toHaveLength(1);
      expect(textOf(await store.readUpdates('pg:c'))).toBe('abc');
      for (const update of typingUpdates('def', doc)) await store.appendUpdate('pg:c', update);
      expect(textOf(await store.readUpdates('pg:c'))).toBe('abcdef');
      await store.compact('pg:unknown');
      expect(await store.listDocs()).toEqual(['pg:c']);
    });

    it('keeps updates appended while a compaction runs', async () => {
      const { store } = await open();
      const doc = new Y.Doc();
      for (const update of typingUpdates('0123456789', doc)) await store.appendUpdate('pg:d', update);
      const more = typingUpdates('abcdefghij', doc);
      await Promise.all([store.compact('pg:d'), ...more.map((update) => store.appendUpdate('pg:d', update))]);
      expect(textOf(await store.readUpdates('pg:d'))).toBe('0123456789abcdefghij');
    });

    it('names blobs by their SHA-256 and stores each once', async () => {
      const { store } = await open();
      const bytes = new TextEncoder().encode('abc');
      const hash = await store.putBlob(bytes);
      expect(hash).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
      expect(await store.putBlob(bytes)).toBe(hash);
      expect(await store.hasBlob(hash)).toBe(true);
      expect(await store.hasBlob(blobHash(new Uint8Array([9])))).toBe(false);
      expect([...((await store.getBlob(hash)) ?? [])]).toEqual([...bytes]);
      expect(await store.listBlobs()).toEqual([hash]);
    });

    it('keeps docs and blobs when opened again', async () => {
      const fixture = await open();
      if (fixture.reopen === undefined) return;
      for (const update of typingUpdates('kept')) await fixture.store.appendUpdate('pg:k', update);
      const hash = await fixture.store.putBlob(new Uint8Array([1, 2, 3]));
      const again = await fixture.reopen();
      expect(textOf(await again.readUpdates('pg:k'))).toBe('kept');
      expect(await again.listDocs()).toEqual(['pg:k']);
      expect(await again.hasBlob(hash)).toBe(true);
    });
  });
}
