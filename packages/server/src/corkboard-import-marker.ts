/**
 * `data/corkboard-import.json`: written before a Corkboard import first
 * writes to the data folder and rewritten when it ends. A file that does not
 * say `finished` means the folder may hold half an import, so neither a new
 * import nor the server starts on it until the owner restores the copy made
 * before the import, which has no marker.
 */
import { randomBytes } from 'node:crypto';
import { open, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { syncFolder } from './disk-store.js';
import { isNotFound, writeAll } from './doc-log.js';

export const IMPORT_MARKER_FILE = 'corkboard-import.json';

export interface ImportMarker {
  /** `started` until every write is made and checked; `differences` when the check found any. */
  state: 'started' | 'finished' | 'differences';
  boardKey: string;
  notebookId: string;
  startedAt: string;
  endedAt: string | null;
}

export async function readImportMarker(dataDir: string): Promise<ImportMarker | null> {
  try {
    return JSON.parse(await readFile(join(dataDir, IMPORT_MARKER_FILE), 'utf8')) as ImportMarker;
  } catch (error) {
    if (isNotFound(error)) return null;
    throw new Error(`${join(dataDir, IMPORT_MARKER_FILE)} cannot be read (${(error as Error).message}); restore the copy of the data folder made before the Corkboard import`);
  }
}

/** Replaces the marker by writing a temporary file, fsyncing it and renaming it into place. */
export async function writeImportMarker(dataDir: string, marker: ImportMarker): Promise<void> {
  const path = join(dataDir, IMPORT_MARKER_FILE);
  const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`;
  const file = await open(tmp, 'w');
  try {
    await writeAll(file, new TextEncoder().encode(`${JSON.stringify(marker, null, 2)}\n`));
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(tmp, path);
  await syncFolder(dataDir);
}

/**
 * A sentence saying what to do when the data folder holds an import that did
 * not finish cleanly, or null when it holds none.
 */
export async function unfinishedImport(dataDir: string): Promise<string | null> {
  const marker = await readImportMarker(dataDir);
  if (marker === null || marker.state === 'finished') return null;
  const path = join(dataDir, IMPORT_MARKER_FILE);
  if (marker.state === 'differences') {
    return (
      `The Corkboard import of ${marker.boardKey} into this data folder at ${marker.startedAt} wrote everything but its check found differences (see its report; ${path} records it). ` +
      'Restore the copy of the data folder made before it, then run the import again.'
    );
  }
  return (
    `The Corkboard import of ${marker.boardKey} into this data folder started at ${marker.startedAt} and did not finish (${path} records it). ` +
    'Restore the copy of the data folder made before it, then run the import again.'
  );
}
