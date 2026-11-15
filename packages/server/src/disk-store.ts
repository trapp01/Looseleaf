/**
 * The server's replica store on disk, laid out as "Server data folder" in
 * docs/architecture.md:
 *
 *   docs/<encoded id>/snapshot   one merged update, replaced by atomic rename
 *   docs/<encoded id>/log        framed updates since the snapshot (doc-log.ts)
 *   blobs/<aa>/<sha256>          immutable bytes, aa = first two hex digits
 *   tmp/                         partial writes, renamed into place when complete
 *
 * Every write is fsynced before its promise resolves. Work on one doc runs in
 * order, so a compaction never races an append or a snapshot copy. A snapshot
 * file that does not decode as a Yjs update is renamed to
 * `snapshot.corrupt-<time>` and the doc reads as its log alone; the log sets
 * aside its own bad records (doc-log.ts). Either way the next handshake with
 * a device restores what was lost.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, open, readdir, readFile, rename, rm, stat, truncate } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { blobHash, isBlobHash, isReadableUpdate, KeyedQueue, mergeDocUpdates, type ReplicaStore } from '@looseleaf/sync';
import { appendRecord, isNotFound, readLog, timestamp, writeAll } from './doc-log.js';

const SNAPSHOT = 'snapshot';
const LOG = 'log';
/** Most file systems cap a name at 255 bytes. */
const MAX_FOLDER_NAME_BYTES = 255;

/** Thrown by `putBlobStream` when the bytes do not hash to the name they were uploaded under. */
export class BlobHashMismatchError extends Error {}
/** Thrown by `putBlobStream` when the upload passes its size limit. */
export class BlobTooLargeError extends Error {}

/**
 * A doc id as a folder name. Lowercase letters, digits, `-` and `_` stay;
 * every other byte of the UTF-8 form, uppercase letters included, becomes
 * %XX. Two ids that differ only in case therefore never share a folder on a
 * case-insensitive file system, and `.` or `..` can never be a name.
 */
export function docFolderName(docId: string): string {
  if (docId === '') throw new Error('A doc id cannot be empty');
  let name = '';
  for (const byte of new TextEncoder().encode(docId)) {
    const char = String.fromCharCode(byte);
    name += /[a-z0-9_-]/.test(char) ? char : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  if (name.length > MAX_FOLDER_NAME_BYTES) {
    throw new Error(`Doc id "${docId.slice(0, 40)}…" is too long to store (${name.length} bytes encoded)`);
  }
  return name;
}

export class DiskStore implements ReplicaStore {
  private readonly queue = new KeyedQueue();
  /** Each log's byte length after its last verified read or successful append in this process. */
  private readonly logLengths = new Map<string, number>();

  constructor(readonly dataDir: string) {}

  get docsDir(): string {
    return join(this.dataDir, 'docs');
  }

  get blobsDir(): string {
    return join(this.dataDir, 'blobs');
  }

  private get tmpDir(): string {
    return join(this.dataDir, 'tmp');
  }

  /** Creates the folders and clears partial writes left by a crash. Call once before use. */
  async init(): Promise<void> {
    await mkdir(this.docsDir, { recursive: true });
    await mkdir(this.blobsDir, { recursive: true });
    await rm(this.tmpDir, { recursive: true, force: true });
    await mkdir(this.tmpDir, { recursive: true });
  }

  async appendUpdate(docId: string, update: Uint8Array): Promise<void> {
    const folder = this.docFolder(docId);
    return this.queue.run(docId, async () => {
      const log = join(folder, LOG);
      // A torn tail must go before the append, or the new record would sit behind it unread.
      // A length other than the one this process left means something wrote or cut the file since.
      const expected = this.logLengths.get(docId);
      if (expected === undefined || (await fileLength(log)) !== expected) await this.readDoc(folder, docId);
      await mkdir(folder, { recursive: true });
      try {
        const added = await appendRecord(log, update);
        this.logLengths.set(docId, (this.logLengths.get(docId) ?? 0) + added);
      } catch (error) {
        this.logLengths.delete(docId);
        throw error;
      }
    });
  }

  async readUpdates(docId: string): Promise<Uint8Array[]> {
    const folder = this.docFolder(docId);
    return this.queue.run(docId, () => this.readDoc(folder, docId));
  }

  /**
   * Writes the merged update as a new snapshot by atomic rename, then empties
   * the log. Throws, changing nothing, when the merged update does not decode.
   */
  async compact(docId: string): Promise<void> {
    const folder = this.docFolder(docId);
    return this.queue.run(docId, async () => {
      const updates = await this.readDoc(folder, docId);
      if (updates.length < 2) return;
      const merged = mergeDocUpdates(updates);
      if (!isReadableUpdate(merged)) throw new Error(`The merged snapshot of doc "${docId}" does not decode; not compacting`);
      await this.writeDurably(join(folder, SNAPSHOT), merged);
      // A crash here leaves the log beside a snapshot that already holds it; replaying it again is harmless.
      await truncate(join(folder, LOG), 0).catch((error: unknown) => {
        if (!isNotFound(error)) throw error;
      });
      this.logLengths.set(docId, 0);
    });
  }

  /**
   * Copies the doc's snapshot and log into `docsDir` (a folder laid out like
   * docs/), inside the doc's queue so no compaction or append lands between
   * the two files.
   */
  async copyDocTo(docId: string, docsDir: string): Promise<void> {
    const name = docFolderName(docId);
    return this.queue.run(docId, async () => {
      await mkdir(join(docsDir, name), { recursive: true });
      for (const file of [SNAPSHOT, LOG]) {
        await copyFile(join(this.docsDir, name, file), join(docsDir, name, file)).catch((error: unknown) => {
          if (!isNotFound(error)) throw error;
        });
      }
    });
  }

  async listDocs(): Promise<string[]> {
    const ids: string[] = [];
    for (const name of await readdir(this.docsDir)) {
      try {
        ids.push(decodeURIComponent(name));
      } catch {
        console.warn(`Ignoring ${join(this.docsDir, name)}: the name is not a percent-encoded doc id`);
      }
    }
    return ids;
  }

  async putBlob(bytes: Uint8Array): Promise<string> {
    const hash = blobHash(bytes);
    if (!(await this.hasBlob(hash))) {
      await mkdir(join(this.blobsDir, hash.slice(0, 2)), { recursive: true });
      await this.writeDurably(this.blobPath(hash), bytes);
    }
    return hash;
  }

  /**
   * Streams an upload to disk while hashing it, and moves it into place only
   * when it hashes to `hash`. Resolves to false when the blob was already
   * stored. Throws BlobTooLargeError past `maxBytes` and BlobHashMismatchError
   * for wrong bytes; nothing is kept in either case.
   */
  async putBlobStream(hash: string, source: AsyncIterable<Uint8Array>, maxBytes: number): Promise<boolean> {
    if (!isBlobHash(hash)) throw new Error(`"${hash}" is not a blob hash`);
    const tmp = join(this.tmpDir, `${hash}.${randomBytes(6).toString('hex')}`);
    const hasher = createHash('sha256');
    const file = await open(tmp, 'w');
    let size = 0;
    try {
      for await (const chunk of source) {
        size += chunk.length;
        if (size > maxBytes) throw new BlobTooLargeError(`Blob ${hash} is larger than the ${maxBytes}-byte limit`);
        hasher.update(chunk);
        await writeAll(file, chunk);
      }
      const actual = hasher.digest('hex');
      if (actual !== hash) {
        throw new BlobHashMismatchError(`Uploaded bytes hash to ${actual}, not to ${hash}`);
      }
      await file.sync();
    } catch (error) {
      await file.close();
      await rm(tmp, { force: true });
      throw error;
    }
    await file.close();
    if (await this.hasBlob(hash)) {
      await rm(tmp, { force: true });
      return false;
    }
    await mkdir(join(this.blobsDir, hash.slice(0, 2)), { recursive: true });
    await rename(tmp, this.blobPath(hash));
    await syncFolder(join(this.blobsDir, hash.slice(0, 2)));
    return true;
  }

  async getBlob(hash: string): Promise<Uint8Array | null> {
    if (!isBlobHash(hash)) return null;
    try {
      return await readFile(this.blobPath(hash));
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  /** The blob as a stream for an HTTP response, or null when it is not stored. */
  async openBlob(hash: string): Promise<{ size: number; stream: Readable } | null> {
    if (!isBlobHash(hash)) return null;
    try {
      const { size } = await stat(this.blobPath(hash));
      return { size, stream: createReadStream(this.blobPath(hash)) };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async hasBlob(hash: string): Promise<boolean> {
    if (!isBlobHash(hash)) return false;
    try {
      await stat(this.blobPath(hash));
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  async listBlobs(): Promise<string[]> {
    const hashes: string[] = [];
    for (const prefix of await readdir(this.blobsDir)) {
      if (!/^[0-9a-f]{2}$/.test(prefix)) continue;
      for (const name of await readdir(join(this.blobsDir, prefix))) {
        if (isBlobHash(name) && name.startsWith(prefix)) hashes.push(name);
      }
    }
    return hashes;
  }

  /** Resolves once every queued doc write has finished. */
  drain(): Promise<void> {
    return this.queue.drain();
  }

  private docFolder(docId: string): string {
    return join(this.docsDir, docFolderName(docId));
  }

  private blobPath(hash: string): string {
    return join(this.blobsDir, hash.slice(0, 2), hash);
  }

  /** The snapshot (when present and readable) followed by the log's good records. Runs inside the doc's queue. */
  private async readDoc(folder: string, docId: string): Promise<Uint8Array[]> {
    const updates: Uint8Array[] = [];
    const snapshotPath = join(folder, SNAPSHOT);
    try {
      const snapshot = await readFile(snapshotPath);
      if (isReadableUpdate(snapshot)) {
        updates.push(snapshot);
      } else {
        const aside = `${snapshotPath}.corrupt-${timestamp()}`;
        await rename(snapshotPath, aside);
        console.warn(`The snapshot of doc "${docId}" does not decode; moved it to ${aside}`);
      }
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    const log = await readLog(join(folder, LOG), isReadableUpdate);
    updates.push(...log.records);
    this.logLengths.set(docId, log.length);
    return updates;
  }

  /** Writes `bytes` to `path` by writing a temporary file, fsyncing it and renaming it over the target. */
  private async writeDurably(path: string, bytes: Uint8Array): Promise<void> {
    const tmp = join(this.tmpDir, `write.${randomBytes(6).toString('hex')}`);
    const file = await open(tmp, 'w');
    try {
      await writeAll(file, bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(tmp, path);
    await syncFolder(join(path, '..'));
  }
}

async function fileLength(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch (error) {
    if (isNotFound(error)) return 0;
    throw error;
  }
}

/** Makes a rename in the folder durable. Some platforms cannot fsync a folder; there the rename is as durable as they allow. */
async function syncFolder(path: string): Promise<void> {
  let folder;
  try {
    folder = await open(path, 'r');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EISDIR' || code === 'EPERM') return;
    throw error;
  }
  try {
    await folder.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EINVAL' && code !== 'EPERM' && code !== 'EISDIR') throw error;
  } finally {
    await folder.close();
  }
}
