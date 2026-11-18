/**
 * Reads docs and blobs from a server data folder laid out as `disk-store.ts`
 * writes it (Looseleaf's, or Corkboard's, which has the same layout) without
 * writing to it: no folders made, no tails set aside, no compaction. A doc
 * the store would have to repair is refused instead, so a reader never sees
 * less than the server would.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as Y from 'yjs';
import { blobHash, isBlobHash, isReadableUpdate } from '@looseleaf/sync';
import { isNotFound, parseLog } from './doc-log.js';
import { docFolderName } from './disk-store.js';

/** Thrown for a doc whose snapshot does not decode or whose log ends in a torn or corrupt record. */
export class UnreadableDocError extends Error {}

export class DataFolderReader {
  constructor(readonly dataDir: string) {}

  /** True when the folder holds the doc. */
  async hasDoc(docId: string): Promise<boolean> {
    return (await this.listDocs()).includes(docId);
  }

  /** Every doc id in docs/; none when the folder has no docs/. */
  async listDocs(): Promise<string[]> {
    let names: string[];
    try {
      names = await readdir(join(this.dataDir, 'docs'));
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
    const ids: string[] = [];
    for (const name of names) {
      try {
        ids.push(decodeURIComponent(name));
      } catch {
        // Not a doc folder; the store ignores it the same way.
      }
    }
    return ids;
  }

  /** The doc built from its snapshot and log; an empty doc when the folder does not hold it. Throws UnreadableDocError. */
  async readDoc(docId: string): Promise<Y.Doc> {
    const doc = new Y.Doc();
    for (const update of await this.readUpdates(docId)) Y.applyUpdate(doc, update);
    return doc;
  }

  /** The snapshot followed by every log record. Throws UnreadableDocError. */
  async readUpdates(docId: string): Promise<Uint8Array[]> {
    const folder = join(this.dataDir, 'docs', docFolderName(docId));
    const updates: Uint8Array[] = [];
    const snapshot = await readIfPresent(join(folder, 'snapshot'));
    if (snapshot !== null) {
      if (!isReadableUpdate(snapshot)) throw new UnreadableDocError(`The snapshot of doc "${docId}" in ${this.dataDir} does not decode`);
      updates.push(snapshot);
    }
    const log = await readIfPresent(join(folder, 'log'));
    if (log !== null) {
      const { records, validLength } = parseLog(log, isReadableUpdate);
      if (validLength < log.length) {
        throw new UnreadableDocError(`The log of doc "${docId}" in ${this.dataDir} ends in ${log.length - validLength} bytes of torn or corrupt records`);
      }
      updates.push(...records);
    }
    return updates;
  }

  /** The blob's bytes, or null when the folder does not hold it. */
  async readBlob(hash: string): Promise<Uint8Array | null> {
    if (!isBlobHash(hash)) return null;
    return readIfPresent(join(this.dataDir, 'blobs', hash.slice(0, 2), hash));
  }

  /** The blob's bytes when it is held and hashes to its name, else why not. */
  async checkedBlob(hash: string): Promise<{ bytes: Uint8Array } | { problem: string }> {
    const bytes = await this.readBlob(hash);
    if (bytes === null) return { problem: 'the blob is not in the folder' };
    const actual = blobHash(bytes);
    return actual === hash ? { bytes } : { problem: `the blob's bytes hash to ${actual}` };
  }
}

async function readIfPresent(path: string): Promise<Uint8Array | null> {
  try {
    return await readFile(path);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}
