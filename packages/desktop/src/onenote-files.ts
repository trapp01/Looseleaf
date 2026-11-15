/**
 * Finding, listing and reading OneNote's `.one` and `.onetoc2` files on disk.
 * These are someone's real notebooks: this module only ever reads. It imports no
 * write function, and the only file it opens is opened with flag 'r'.
 */
import { access, constants, lstat, open, readdir, realpath, stat } from 'node:fs/promises';
import { join, posix, win32 } from 'node:path';

export interface OneNoteFile {
  /** Relative to the listed folder, `/`-separated on every platform. */
  path: string;
  size: number;
}

export function isOneNoteFileName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith('.one') || lower.endsWith('.onetoc2');
}

/** Where OneNote keeps its backups on this platform, whether or not the folder exists. */
export function oneNoteBackupCandidate(
  platform: NodeJS.Platform,
  homeDir: string,
  env: Record<string, string | undefined>,
): string | null {
  if (platform === 'darwin') {
    return posix.join(
      homeDir,
      'Library/Containers/com.microsoft.onenote.mac/Data/Library/Application Support',
      'Microsoft User Data/OneNote/15.0/Backup',
    );
  }
  if (platform === 'win32' && env.LOCALAPPDATA) {
    return win32.join(env.LOCALAPPDATA, 'Microsoft', 'OneNote', '16.0', 'Backup');
  }
  return null;
}

/** The backup folder when it exists and can be read, else null. */
export async function findOneNoteBackups(
  platform: NodeJS.Platform,
  homeDir: string,
  env: Record<string, string | undefined>,
): Promise<string | null> {
  const folder = oneNoteBackupCandidate(platform, homeDir, env);
  if (!folder) return null;
  try {
    if (!(await stat(folder)).isDirectory()) return null;
    await access(folder, constants.R_OK);
    return folder;
  } catch {
    return null;
  }
}

/**
 * Every OneNote file under `folder`, sorted by path. Symbolic links are skipped,
 * files and folders alike, and subfolders that cannot be read are left out.
 */
export async function listOneNoteFiles(folder: string): Promise<OneNoteFile[]> {
  const found: OneNoteFile[] = [];
  await walk(folder, '', found);
  return found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

async function walk(dir: string, prefix: string, found: OneNoteFile[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (prefix !== '' && isAccessError(error)) return;
    throw error;
  }
  for (const entry of entries) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) await walk(full, relative, found);
    else if (entry.isFile() && isOneNoteFileName(entry.name)) {
      found.push({ path: relative, size: (await lstat(full)).size });
    }
  }
}

function isAccessError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'EACCES' || code === 'EPERM';
}

/**
 * The bytes of one OneNote file inside `folder`. `relativePath` is a path as
 * `listOneNoteFiles` returns it. Throws for an absolute path, any `..` segment,
 * a path that passes through a symbolic link, or a name that is not a OneNote file.
 */
export async function readOneNoteFile(folder: string, relativePath: string): Promise<Uint8Array> {
  const segments = relativePath.split(/[\\/]/);
  const refuse = (why: string) => new Error(`Refusing to read "${relativePath}" in ${folder}: ${why}`);
  if (relativePath.includes('\0') || posix.isAbsolute(relativePath) || win32.isAbsolute(relativePath)) {
    throw refuse('the path must be relative to the folder');
  }
  if (segments.some((s) => s === '' || s === '.' || s === '..' || s.includes(':'))) {
    throw refuse('the path must stay inside the folder');
  }
  if (!isOneNoteFileName(relativePath)) throw refuse('only .one and .onetoc2 files can be read');

  const target = join(await realpath(folder), ...segments);
  const resolved = await realpath(target);
  if (resolved !== target) throw refuse(`it resolves to ${resolved}, which is not the file inside the folder`);

  const handle = await open(target, 'r');
  try {
    if (!(await handle.stat()).isFile()) throw refuse('it is not a file');
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}
