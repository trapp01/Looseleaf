/**
 * Daily snapshots of the data folder: snapshots/<yyyy-mm-dd>/ holds a copy of
 * every doc's snapshot and log, each doc copied inside its store queue so the
 * pair is consistent, and hard links to every file in blobs/ (blobs never
 * change, so a link costs no space). A snapshot is built under a temporary
 * name and renamed into place, so a dated folder is always complete. Dates
 * are the server's local date. Restoring is described in
 * packages/server/README.md.
 */
import { copyFile, link, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { DiskStore } from './disk-store.js';
import { isNotFound } from './doc-log.js';

/** How often the server checks whether today's snapshot exists yet. */
export const SNAPSHOT_CHECK_INTERVAL_MS = 60 * 60 * 1000;
export const DEFAULT_SNAPSHOT_KEEP = 14;

const DATED = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Takes today's snapshot now if it is missing, then checks again every hour.
 * The returned stop function waits for a snapshot in progress to finish.
 */
export function startSnapshots(store: DiskStore, keep: number): () => Promise<void> {
  let current: Promise<void> | null = null;
  const run = () => {
    if (current !== null) return;
    current = takeSnapshotIfMissing(store, keep)
      .then(() => undefined)
      .catch((error: unknown) => {
        console.error(`Could not take today's snapshot of ${store.dataDir}`, error);
      })
      .finally(() => {
        current = null;
      });
  };
  run();
  const timer = setInterval(run, SNAPSHOT_CHECK_INTERVAL_MS);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await current;
  };
}

/**
 * Writes snapshots/<date>/ unless it exists, then deletes all but the newest
 * `keep` dated snapshots. Resolves to the new snapshot's path, or null when
 * the day already had one.
 */
export async function takeSnapshotIfMissing(store: DiskStore, keep: number, now = new Date()): Promise<string | null> {
  const dataDir = store.dataDir;
  const root = join(dataDir, 'snapshots');
  const target = join(root, localDate(now));
  if (await exists(target)) return null;
  await mkdir(root, { recursive: true });
  const partial = join(root, `.partial-${localDate(now)}-${process.pid}`);
  await rm(partial, { recursive: true, force: true });
  await mkdir(partial);
  await mkdir(join(partial, 'docs'));
  for (const docId of await store.listDocs()) await store.copyDocTo(docId, join(partial, 'docs'));
  await linkBlobs(join(dataDir, 'blobs'), join(partial, 'blobs'));
  await rename(partial, target);
  await pruneSnapshots(root, keep);
  console.log(`Snapshot written to ${target}`);
  return target;
}

async function linkBlobs(from: string, to: string): Promise<void> {
  await mkdir(to, { recursive: true });
  if (!(await exists(from))) return;
  for (const prefix of await readdir(from)) {
    await mkdir(join(to, prefix), { recursive: true });
    for (const name of await readdir(join(from, prefix))) {
      const source = join(from, prefix, name);
      const dest = join(to, prefix, name);
      try {
        await link(source, dest);
      } catch (error) {
        // File systems without hard links (some network mounts) get a copy instead.
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'EXDEV' && code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'EMLINK') throw error;
        await copyFile(source, dest);
      }
    }
  }
}

async function pruneSnapshots(root: string, keep: number): Promise<void> {
  const dated = (await readdir(root)).filter((name) => DATED.test(name)).sort();
  for (const name of dated.slice(0, Math.max(0, dated.length - keep))) {
    await rm(join(root, name), { recursive: true, force: true });
  }
}

function localDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}
