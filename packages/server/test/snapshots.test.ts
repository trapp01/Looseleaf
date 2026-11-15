import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { captureUpdates, textOf } from '@looseleaf/sync/testing';
import { DiskStore, docFolderName } from '../src/disk-store.js';
import { takeSnapshotIfMissing } from '../src/snapshots.js';
import { tempDir } from './harness.js';

async function storeWithData(): Promise<{ store: DiskStore; hash: string }> {
  const store = new DiskStore(await tempDir());
  await store.init();
  await store.appendUpdate('pg:a', new Uint8Array([0, 0]));
  const hash = await store.putBlob(new TextEncoder().encode('blob bytes'));
  return { store, hash };
}

describe('snapshots', () => {
  it('copies docs and hard-links blobs into a dated folder, once per day', async () => {
    const { store, hash } = await storeWithData();
    const day = new Date(2026, 10, 15, 9, 30);
    const path = await takeSnapshotIfMissing(store, 14, day);
    expect(path).toBe(join(store.dataDir, 'snapshots', '2026-11-15'));
    const copiedLog = join(path!, 'docs', docFolderName('pg:a'), 'log');
    expect(await readFile(copiedLog)).toEqual(await readFile(join(store.docsDir, docFolderName('pg:a'), 'log')));
    const original = await stat(join(store.blobsDir, hash.slice(0, 2), hash));
    const linked = await stat(join(path!, 'blobs', hash.slice(0, 2), hash));
    expect(linked.ino).toBe(original.ino);
    expect(await takeSnapshotIfMissing(store, 14, new Date(2026, 10, 15, 23, 0))).toBeNull();
  });

  it('keeps only the newest snapshots', async () => {
    const { store } = await storeWithData();
    for (let day = 1; day <= 5; day++) await takeSnapshotIfMissing(store, 3, new Date(2026, 10, day));
    expect(await readdir(join(store.dataDir, 'snapshots'))).toEqual(['2026-11-03', '2026-11-04', '2026-11-05']);
  });

  it('copies each doc whole while compactions run at the same time', async () => {
    const store = new DiskStore(await tempDir());
    await store.init();
    const ids = Array.from({ length: 40 }, (_, i) => `pg:${i}`);
    for (const id of ids) {
      const doc = new Y.Doc();
      for (const update of captureUpdates(doc, (d) => {
        for (const char of 'abcdef') d.getText('t').insert(d.getText('t').length, char);
      })) {
        await store.appendUpdate(id, update);
      }
    }
    const [path] = await Promise.all([
      takeSnapshotIfMissing(store, 14, new Date(2026, 0, 3)),
      ...ids.map((id) => store.compact(id)),
    ]);
    const copy = new DiskStore(path!);
    for (const id of ids) expect(textOf(await copy.readUpdates(id))).toBe('abcdef');
  });

  it('snapshots an empty data folder', async () => {
    const store = new DiskStore(await tempDir());
    await store.init();
    const path = await takeSnapshotIfMissing(store, 14, new Date(2026, 0, 2));
    expect((await readdir(path!)).sort()).toEqual(['blobs', 'docs']);
  });
});
