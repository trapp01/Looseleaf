/**
 * A notebook folder of `.one` files to one import-tree notebook. Subfolders
 * become section groups, backup suffixes come off section names, only the
 * newest copy of each section is read, and the recycle bin is skipped.
 * Sections and groups are ordered alphabetically, sections first.
 */
import type { ImportedNotebook, ImportedPage, ImportedSection, ImportedSectionGroup } from '../../model/src/import-tree.js';
import { OneNoteReadError } from './errors.js';
import { readOneSection } from './section.js';

/** A file of the notebook folder; `path` is relative to the folder, with / or \ separators. */
export interface NotebookFile {
  path: string;
  bytes: Uint8Array;
}

/** A notebook file read on demand, so only one section's bytes are in memory at a time. */
export interface LazyNotebookFile {
  path: string;
  read(): Promise<Uint8Array>;
}

const RECYCLE_BIN = 'onenote_recyclebin';

/**
 * A backup copy's name without its suffixes. OneNote's backups are named
 * `Name.one (On 2024-05-01).one` or `Name (On 2024-05-01 - 2).one`, and a backup
 * of a backup repeats the suffix. `date` and `copy` come from the outermost
 * suffix; a file without one has neither.
 */
export function parseBackupName(fileName: string): { name: string; date?: string; copy?: number } {
  let name = fileName.replace(/\.one$/i, '');
  let date: string | undefined;
  let copy: number | undefined;
  for (;;) {
    const match = / \(On (\d{4}-\d{2}-\d{2})(?: - (\d+))?\)$/.exec(name);
    if (!match) break;
    if (date === undefined) {
      date = match[1];
      copy = match[2] ? Number(match[2]) : 0;
    }
    name = name.slice(0, match.index).replace(/\.one$/i, '');
  }
  return { name, ...(date !== undefined ? { date, copy } : {}) };
}

/**
 * True when backup `a` is newer than backup `b`: a file without a backup
 * suffix is the live section and beats any backup; then the later date, then
 * the higher copy number.
 */
export function isNewerBackup(a: { date?: string; copy?: number }, b: { date?: string; copy?: number }): boolean {
  if (a.date === undefined || b.date === undefined) return a.date === undefined && b.date !== undefined;
  if (a.date !== b.date) return a.date > b.date;
  return (a.copy ?? 0) > (b.copy ?? 0);
}

interface PlannedSection {
  groups: string[];
  name: string;
  path: string;
}

/** Chooses which file to read for each section and where it sits in the group tree. */
export function planNotebook(paths: string[]): PlannedSection[] {
  const chosen = new Map<string, PlannedSection & { date?: string; copy?: number }>();
  for (const path of paths) {
    const segments = path.replace(/\\/g, '/').split('/').filter((s) => s !== '' && s !== '.');
    const fileName = segments.pop();
    if (!fileName || !/\.one$/i.test(fileName) || fileName.startsWith('.')) continue;
    if (segments.some((s) => s.toLowerCase() === RECYCLE_BIN)) continue;
    const backup = parseBackupName(fileName);
    const key = [...segments, backup.name].join('/').toLowerCase();
    const candidate = { groups: segments, path, ...backup };
    const current = chosen.get(key);
    if (!current || isNewerBackup(candidate, current) || (!isNewerBackup(current, candidate) && path > current.path)) {
      chosen.set(key, candidate);
    }
  }
  return [...chosen.values()].map(({ groups, name, path }) => ({ groups, name, path }));
}

const byName = (a: { name: string }, b: { name: string }) =>
  a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });

function assemble(name: string, sections: Array<{ groups: string[]; section: ImportedSection }>): ImportedNotebook {
  const notebook: ImportedNotebook = { name, children: [] };
  const groupsByPath = new Map<string, ImportedSectionGroup>();
  const containerFor = (groups: string[]) => {
    let children = notebook.children;
    for (let i = 0; i < groups.length; i++) {
      const key = groups.slice(0, i + 1).join('/').toLowerCase();
      let group = groupsByPath.get(key);
      if (!group) {
        group = { kind: 'group', name: groups[i]!, children: [] };
        groupsByPath.set(key, group);
        children.push(group);
      }
      children = group.children;
    }
    return children;
  };
  for (const { groups, section } of sections) containerFor(groups).push(section);
  const sort = (children: ImportedNotebook['children']) => {
    children.sort((a, b) => (a.kind === b.kind ? byName(a, b) : a.kind === 'section' ? -1 : 1));
    for (const child of children) if (child.kind === 'group') sort(child.children);
  };
  sort(notebook.children);
  return notebook;
}

/** A section that failed to read becomes an empty page carrying the reason, so the import report shows it. */
function unreadableSection(name: string, error: OneNoteReadError): ImportedSection {
  const page: ImportedPage = {
    title: '',
    level: 0,
    containers: [],
    strokes: [],
    warnings: [`This section could not be imported: ${error.message}`],
  };
  return { kind: 'section', name, pages: [page] };
}

function readPlanned(planned: PlannedSection, bytes: Uint8Array): ImportedSection {
  try {
    return readOneSection(bytes, { name: planned.name });
  } catch (e) {
    if (e instanceof OneNoteReadError) return unreadableSection(planned.name, e);
    throw e;
  }
}

/**
 * Reads a notebook folder whose files are all in memory. `path` is relative to
 * the notebook folder. Files that are not `.one`, and everything under
 * OneNote_RecycleBin, are ignored.
 */
export function readNotebookFolder(files: NotebookFile[], options: { name: string }): ImportedNotebook {
  const byPath = new Map(files.map((file) => [file.path, file.bytes]));
  const sections = planNotebook(files.map((file) => file.path)).map((planned) => ({
    groups: planned.groups,
    section: readPlanned(planned, byPath.get(planned.path)!),
  }));
  return assemble(options.name, sections);
}

/**
 * Reads a notebook folder one file at a time, reading only the files it
 * chooses. Each file's bytes can be freed as soon as its section is built,
 * since the import tree holds copies of the pictures and files it needs.
 */
export async function readNotebookFolderLazily(files: LazyNotebookFile[], options: { name: string }): Promise<ImportedNotebook> {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const sections: Array<{ groups: string[]; section: ImportedSection }> = [];
  for (const planned of planNotebook(files.map((file) => file.path))) {
    const bytes = await byPath.get(planned.path)!.read();
    sections.push({ groups: planned.groups, section: readPlanned(planned, bytes) });
  }
  return assemble(options.name, sections);
}
