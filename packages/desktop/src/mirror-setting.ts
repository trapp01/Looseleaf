/**
 * The mirror folder the person chose, kept in a small JSON file in user data
 * between launches. Only the folder's path is stored; what goes into the
 * folder is decided by `ipc.ts` and `@looseleaf/server/mirror-folder`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

/** The remembered mirror folder, or null when none was chosen or the file is missing or damaged. */
export function loadMirrorFolder(file: string): string | null {
  let saved: unknown = null;
  try {
    saved = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    // A missing or damaged file means no mirror folder.
  }
  const folder = typeof saved === 'object' && saved !== null ? (saved as Record<string, unknown>).folder : null;
  return typeof folder === 'string' && isAbsolute(folder) && !folder.includes('\0') ? folder : null;
}

/** Remembers the folder, or forgets it when given null. */
export function saveMirrorFolder(file: string, folder: string | null): void {
  writeFileSync(file, `${JSON.stringify({ folder })}\n`);
}
