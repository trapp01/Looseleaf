import { mkdirSync, mkdtempSync, statSync, symlinkSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A folder shaped like a OneNote backup folder, filled with made-up bytes, plus
 * a OneNote file outside it that symbolic links inside point at. Written with
 * `node:fs` so tests that mock `node:fs/promises` can still build it.
 */
export function oneNoteFixture(): { root: string; folder: string; outside: string } {
  const root = mkdtempSync(join(tmpdir(), 'looseleaf-onenote-'));
  const folder = join(root, 'Backup');
  const write = (path: string, bytes: number[]) => {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, Buffer.from(bytes));
  };
  write(join(folder, 'Work', 'Open Notebook.onetoc2'), [1, 2, 3]);
  write(join(folder, 'Work', 'Meetings (On 14-11-2026).one'), [4, 5, 6, 7]);
  write(join(folder, 'Work', 'Archive', 'Old.ONE'), [8]);
  write(join(folder, 'Personal', 'Recipes.one'), [9, 10]);
  write(join(folder, 'Personal', 'notes.txt'), [11]);
  write(join(folder, 'Personal', 'Recipes.one.bak'), [12]);
  write(join(folder, 'Personal', 'onenote'), [13]);
  const outside = join(root, 'Elsewhere');
  write(join(outside, 'Private.one'), [99, 99]);
  symlinkSync(join(outside, 'Private.one'), join(folder, 'Personal', 'Linked.one'));
  symlinkSync(outside, join(folder, 'Linked folder'));
  return { root, folder, outside };
}

/** Bytes, mtime and ctime of every file under the fixture root, to compare before and after. */
export function snapshotFiles(paths: string[]): Array<{ path: string; bytes: string; mtimeMs: number; ctimeMs: number }> {
  return paths.map((path) => {
    const info = statSync(path);
    return { path, bytes: readFileSync(path).toString('hex'), mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs };
  });
}
