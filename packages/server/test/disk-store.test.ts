import { appendFile, open, readdir, readFile, stat, truncate, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { blobHash, mergeDocUpdates } from '@looseleaf/sync';
import { captureUpdates, describeReplicaStore, textOf } from '@looseleaf/sync/testing';
import { BlobHashMismatchError, BlobTooLargeError, DiskStore, docFolderName } from '../src/disk-store.js';
import { encodeRecord, parseLog } from '../src/doc-log.js';
import { tempDir } from './harness.js';

async function openStore(dir?: string): Promise<DiskStore> {
  const store = new DiskStore(dir ?? (await tempDir()));
  await store.init();
  return store;
}

describeReplicaStore('disk', async () => {
  const store = await openStore();
  return { store, reopen: () => openStore(store.dataDir) };
});

/** Three single-character updates typed into one doc. */
function threeUpdates(): Uint8Array[] {
  return captureUpdates(new Y.Doc(), (doc) => {
    for (const char of 'xyz') doc.getText('t').insert(doc.getText('t').length, char);
  });
}

describe('doc log', () => {
  it('frames a record as little-endian length, crc32, then the bytes', () => {
    const record = encodeRecord(new Uint8Array([97, 98, 99]));
    expect([...record.subarray(0, 4)]).toEqual([3, 0, 0, 0]);
    // crc32("abc") = 0x352441c2
    expect([...record.subarray(4, 8)]).toEqual([0xc2, 0x41, 0x24, 0x35]);
    expect([...record.subarray(8)]).toEqual([97, 98, 99]);
  });

  it('stops at a zero-filled tail', () => {
    const good = encodeRecord(new Uint8Array([1]));
    const bytes = new Uint8Array(good.length + 16);
    bytes.set(good);
    expect(parseLog(bytes)).toMatchObject({ validLength: good.length });
    expect(parseLog(bytes).records).toHaveLength(1);
  });
});

describe('disk store files', () => {
  it('percent-encodes doc ids, uppercase letters and dots included', async () => {
    expect(docFolderName('library')).toBe('library');
    expect(docFolderName('pg:Ab_9-')).toBe('pg%3A%41b_9-');
    expect(docFolderName('..')).toBe('%2E%2E');
    expect(docFolderName('pg:é/')).toBe('pg%3A%C3%A9%2F');
    expect(() => docFolderName('')).toThrow(/empty/);
    expect(() => docFolderName('x'.repeat(300))).toThrow(/too long/);
    const store = await openStore();
    await store.appendUpdate('pg:AB', threeUpdates()[0]!);
    await store.appendUpdate('pg:ab', threeUpdates()[0]!);
    expect((await readdir(store.docsDir)).sort()).toEqual(['pg%3A%41%42', 'pg%3Aab']);
    expect((await store.listDocs()).sort()).toEqual(['pg:AB', 'pg:ab']);
  });

  it('drops a torn last record, truncates the log to the good records, and appends after them', async () => {
    const store = await openStore();
    const updates = threeUpdates();
    for (const update of updates) await store.appendUpdate('pg:t', update);
    const log = join(store.docsDir, docFolderName('pg:t'), 'log');
    const goodLength = encodeRecord(updates[0]!).length + encodeRecord(updates[1]!).length;
    await truncate(log, goodLength + 5);

    const reopened = await openStore(store.dataDir);
    expect(textOf(await reopened.readUpdates('pg:t'))).toBe('xy');
    expect((await stat(log)).size).toBe(goodLength);
    // The dropped bytes are kept beside the log, not discarded.
    const aside = (await readdir(join(store.docsDir, docFolderName('pg:t')))).filter((name) => name.startsWith('log.corrupt-'));
    expect(aside).toHaveLength(1);
    expect((await stat(join(store.docsDir, docFolderName('pg:t'), aside[0]!))).size).toBe(5);
    await reopened.appendUpdate('pg:t', updates[2]!);
    expect(textOf(await (await openStore(store.dataDir)).readUpdates('pg:t'))).toBe('xyz');
  });

  it('drops a record with a flipped byte and everything after it', async () => {
    const store = await openStore();
    const updates = threeUpdates();
    for (const update of updates) await store.appendUpdate('pg:f', update);
    const log = join(store.docsDir, docFolderName('pg:f'), 'log');
    const bytes = await readFile(log);
    const second = encodeRecord(updates[0]!).length + 8;
    bytes[second] = bytes[second]! ^ 0xff;
    await writeFile(log, bytes);

    const reopened = await openStore(store.dataDir);
    expect(await reopened.readUpdates('pg:f')).toHaveLength(1);
    expect((await stat(log)).size).toBe(encodeRecord(updates[0]!).length);
  });

  it('repairs a partial record written after the log was checked, before the next append', async () => {
    const store = await openStore();
    const updates = threeUpdates();
    await store.appendUpdate('pg:p', updates[0]!);
    // What a failed append (ENOSPC, EIO) leaves behind: part of a record.
    await appendFile(join(store.docsDir, docFolderName('pg:p'), 'log'), Buffer.from([40, 0, 0, 0, 1, 2, 3, 4, 9, 9]));
    await store.appendUpdate('pg:p', updates[1]!);
    expect(textOf(await (await openStore(store.dataDir)).readUpdates('pg:p'))).toBe('xy');
  });

  it('sets aside a record whose checksum is right but whose bytes do not decode', async () => {
    const store = await openStore();
    const updates = threeUpdates();
    await store.appendUpdate('pg:g', updates[0]!);
    const log = join(store.docsDir, docFolderName('pg:g'), 'log');
    await appendFile(log, encodeRecord(new Uint8Array([0xff, 0xff, 0xff])));
    const reopened = await openStore(store.dataDir);
    expect(textOf(await reopened.readUpdates('pg:g'))).toBe('x');
    await reopened.appendUpdate('pg:g', updates[1]!);
    expect(textOf(await (await openStore(store.dataDir)).readUpdates('pg:g'))).toBe('xy');
  });

  it('sets aside a snapshot that does not decode and reads the doc from its log', async () => {
    const store = await openStore();
    const updates = threeUpdates();
    for (const update of updates) await store.appendUpdate('pg:s', update);
    const folder = join(store.docsDir, docFolderName('pg:s'));
    await writeFile(join(folder, 'snapshot'), mergeDocUpdates(updates).subarray(0, 5));
    const reopened = await openStore(store.dataDir);
    expect(textOf(await reopened.readUpdates('pg:s'))).toBe('xyz');
    expect((await readdir(folder)).some((name) => name.startsWith('snapshot.corrupt-'))).toBe(true);
    expect(await readdir(folder)).not.toContain('snapshot');
  });

  it('finishes a compaction when the disk takes each write in pieces', async () => {
    const store = await openStore();
    for (const update of threeUpdates()) await store.appendUpdate('pg:w', update);
    const probe = await open(join(store.dataDir, 'probe'), 'w');
    const proto = Object.getPrototypeOf(probe) as { write: (...args: unknown[]) => Promise<{ bytesWritten: number }> };
    await probe.close();
    const realWrite = proto.write;
    // Each write stores at most 3 bytes, as a nearly full disk may.
    proto.write = function (this: unknown, buffer: unknown, ...rest: unknown[]) {
      if (buffer instanceof Uint8Array && rest.length === 0) return realWrite.call(this, buffer.subarray(0, 3));
      return realWrite.call(this, buffer, ...rest);
    };
    try {
      await store.compact('pg:w');
    } finally {
      proto.write = realWrite;
    }
    expect(textOf(await (await openStore(store.dataDir)).readUpdates('pg:w'))).toBe('xyz');
  });

  it('fails a compaction, changing nothing, when the disk takes no bytes', async () => {
    const store = await openStore();
    for (const update of threeUpdates()) await store.appendUpdate('pg:n', update);
    const probe = await open(join(store.dataDir, 'probe'), 'w');
    const proto = Object.getPrototypeOf(probe) as { write: (...args: unknown[]) => Promise<{ bytesWritten: number }> };
    await probe.close();
    const realWrite = proto.write;
    proto.write = async () => ({ bytesWritten: 0 });
    try {
      await expect(store.compact('pg:n')).rejects.toThrow(/Writing stopped/);
    } finally {
      proto.write = realWrite;
    }
    expect(await (await openStore(store.dataDir)).readUpdates('pg:n')).toHaveLength(3);
  });

  it('repairs a torn log before the first append when the doc was never read', async () => {
    const store = await openStore();
    const updates = threeUpdates();
    await store.appendUpdate('pg:r', updates[0]!);
    const log = join(store.docsDir, docFolderName('pg:r'), 'log');
    await writeFile(log, new Uint8Array([9, 9, 9]), { flag: 'a' });
    const reopened = await openStore(store.dataDir);
    await reopened.appendUpdate('pg:r', updates[1]!);
    expect(textOf(await reopened.readUpdates('pg:r'))).toBe('xy');
  });

  it('compacts into the snapshot by rename and empties the log', async () => {
    const store = await openStore();
    for (const update of threeUpdates()) await store.appendUpdate('pg:c', update);
    await store.compact('pg:c');
    const folder = join(store.docsDir, docFolderName('pg:c'));
    expect((await readdir(folder)).sort()).toEqual(['log', 'snapshot']);
    expect((await stat(join(folder, 'log'))).size).toBe(0);
    expect(textOf([await readFile(join(folder, 'snapshot'))])).toBe('xyz');
  });

  it('reads correctly after a crash at any point of a compaction', async () => {
    const store = await openStore();
    const updates = threeUpdates();
    for (const update of updates) await store.appendUpdate('pg:k', update);
    const folder = join(store.docsDir, docFolderName('pg:k'));
    // Crash after the snapshot was written to tmp/ but before the rename.
    await writeFile(join(store.dataDir, 'tmp', 'write.partial'), mergeDocUpdates(updates).subarray(0, 3));
    expect(textOf(await (await openStore(store.dataDir)).readUpdates('pg:k'))).toBe('xyz');
    expect(await readdir(join(store.dataDir, 'tmp'))).toEqual([]);
    // Crash after the rename but before the log was emptied: the snapshot and the log hold the same updates.
    await writeFile(join(folder, 'snapshot'), mergeDocUpdates(updates));
    const reopened = await openStore(store.dataDir);
    expect(await reopened.readUpdates('pg:k')).toHaveLength(4);
    expect(textOf(await reopened.readUpdates('pg:k'))).toBe('xyz');
  });
});

describe('disk store blob uploads', () => {
  const chunks = (...parts: string[]) => Readable.from(parts.map((part) => Buffer.from(part)));

  it('stores streamed bytes under their hash, once', async () => {
    const store = await openStore();
    const hash = blobHash(new TextEncoder().encode('hello world'));
    expect(await store.putBlobStream(hash, chunks('hello ', 'world'), 1000)).toBe(true);
    expect(await store.putBlobStream(hash, chunks('hello world'), 1000)).toBe(false);
    expect(new TextDecoder().decode((await store.getBlob(hash))!)).toBe('hello world');
    expect(await readdir(join(store.blobsDir, hash.slice(0, 2)))).toEqual([hash]);
  });

  it('rejects bytes that do not match the hash and keeps nothing', async () => {
    const store = await openStore();
    const hash = blobHash(new TextEncoder().encode('expected'));
    await expect(store.putBlobStream(hash, chunks('tampered'), 1000)).rejects.toBeInstanceOf(BlobHashMismatchError);
    expect(await store.hasBlob(hash)).toBe(false);
    expect(await store.listBlobs()).toEqual([]);
    expect(await readdir(join(store.dataDir, 'tmp'))).toEqual([]);
  });

  it('rejects an upload past the size limit', async () => {
    const store = await openStore();
    const hash = blobHash(new TextEncoder().encode('0123456789'));
    await expect(store.putBlobStream(hash, chunks('01234', '56789'), 8)).rejects.toBeInstanceOf(BlobTooLargeError);
    expect(await store.hasBlob(hash)).toBe(false);
  });
});
