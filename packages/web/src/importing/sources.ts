/**
 * Where OneNote files come from: the desktop shell's file access (OneNote's
 * backup folder or a chosen folder), a browser folder picker, or files and
 * folders dropped on the dialog. Each becomes one ImportSource per notebook.
 * Shell folders are used only in the session they were chosen in.
 */
import type { ShellBridge } from '../shell-bridge.js';
import type { ImportFile, ImportSource } from './import-run.js';

const isSection = (path: string) => /\.one$/i.test(path);

function splitFirst(path: string): [string, string] {
  const clean = path.replace(/\\/g, '/').replace(/^\/+/, '');
  const at = clean.indexOf('/');
  return at === -1 ? ['', clean] : [clean.slice(0, at), clean.slice(at + 1)];
}

function baseName(folder: string): string {
  return folder.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'Imported notebook';
}

/** OneNote's backup folder holds one folder per notebook; each found notebook with its files. */
export async function shellBackupNotebooks(bridge: ShellBridge, root: string): Promise<ImportSource[]> {
  const files = (await bridge.listOneNoteFiles(root)).filter((f) => isSection(f.path));
  const byNotebook = new Map<string, ImportFile[]>();
  for (const f of files) {
    const [notebook, rest] = splitFirst(f.path);
    if (!notebook) continue;
    const list = byNotebook.get(notebook) ?? [];
    list.push({ path: rest, size: f.size, read: () => bridge.readOneNoteFile(root, f.path) });
    byNotebook.set(notebook, list);
  }
  return [...byNotebook].map(([notebookName, list]) => ({ notebookName, files: list })).sort((a, b) => a.notebookName.localeCompare(b.notebookName));
}

/** A folder chosen in the shell is one notebook named after the folder. */
export async function shellFolderNotebook(bridge: ShellBridge, folder: string): Promise<ImportSource> {
  const files = (await bridge.listOneNoteFiles(folder)).filter((f) => isSection(f.path));
  return {
    notebookName: baseName(folder),
    files: files.map((f) => ({ path: f.path.replace(/\\/g, '/'), size: f.size, read: () => bridge.readOneNoteFile(folder, f.path) })),
  };
}

function fromFile(file: File, path: string): ImportFile {
  return { path, size: file.size, read: async () => new Uint8Array(await file.arrayBuffer()) };
}

/**
 * Files from `<input webkitdirectory>` or a drop, with their paths. Files under
 * a top folder make one notebook per top folder; loose `.one` files make one
 * notebook called `looseName`.
 */
export function browserNotebooks(entries: Array<{ file: File; path: string }>, looseName: string): ImportSource[] {
  const byNotebook = new Map<string, ImportFile[]>();
  for (const { file, path } of entries) {
    if (!isSection(path)) continue;
    const [top, rest] = splitFirst(path);
    const name = top || looseName;
    const list = byNotebook.get(name) ?? [];
    list.push(fromFile(file, top ? rest : path));
    byNotebook.set(name, list);
  }
  return [...byNotebook].map(([notebookName, files]) => ({ notebookName, files }));
}

/** Every file in a drop, walking dropped folders. */
export async function droppedFiles(data: DataTransfer): Promise<Array<{ file: File; path: string }>> {
  const out: Array<{ file: File; path: string }> = [];
  const entries = [...data.items].map((item) => item.webkitGetAsEntry?.()).filter((e): e is FileSystemEntry => !!e);
  if (entries.length === 0) return [...data.files].map((file) => ({ file, path: file.name }));
  const walk = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
      out.push({ file, path: prefix + entry.name });
      return;
    }
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
      if (batch.length === 0) break;
      for (const child of batch) await walk(child, `${prefix}${entry.name}/`);
    }
  };
  for (const entry of entries) await walk(entry, '');
  return out;
}
