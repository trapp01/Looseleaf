/**
 * What the main process does for each bridge call: argument checks, the
 * folder grants that limit OneNote reads, and the work itself. Electron objects
 * arrive through `ShellHost` and `HandlerDeps`, so this runs in Node tests.
 * The page's origin is checked by the caller before a handler runs.
 */
import { realpath } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, sep } from 'node:path';
import { CHANNELS, type InvokeChannel } from './channels.js';
import { findOneNoteBackups, listOneNoteFiles, readOneNoteFile } from './onenote-files.js';

/** Native UI tied to the window that made the call. */
export interface ShellHost {
  /** Resolves to the chosen path, or null when cancelled. */
  showSaveDialog(defaultPath: string, filters: Array<{ name: string; extensions: string[] }>): Promise<string | null>;
  showFolderDialog(): Promise<string | null>;
  printToPdf(): Promise<Uint8Array>;
}

export interface HandlerDeps {
  platform: NodeJS.Platform;
  homeDir: string;
  env: Record<string, string | undefined>;
  /** Where save dialogs open. */
  saveFolder: string;
  /** The only way a handler writes to disk; used by saveFile and savePdf alone. */
  writeFile(path: string, bytes: Uint8Array): Promise<void>;
}

export type Handler = (host: ShellHost, args: unknown[]) => Promise<unknown>;

const MAX_NAME_LENGTH = 255;
const MAX_PATH_LENGTH = 4096;

export function expectString(value: unknown, what: string, maxLength: number): string {
  if (typeof value !== 'string') throw new TypeError(`${what} must be a string, got ${describe(value)}`);
  if (value.length === 0 || value.length > maxLength) {
    throw new TypeError(`${what} must be 1 to ${maxLength} characters, got ${value.length}`);
  }
  return value;
}

export function expectBytes(value: unknown, what: string): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new TypeError(`${what} must be a Uint8Array, got ${describe(value)}`);
  return value;
}

export function expectAbsolutePath(value: unknown, what: string): string {
  const path = expectString(value, what, MAX_PATH_LENGTH);
  if (!isAbsolute(path) || path.includes('\0')) throw new TypeError(`${what} must be an absolute path, got "${path}"`);
  return path;
}

export function expectArgCount(args: unknown[], count: number, channel: string): void {
  if (args.length !== count) throw new TypeError(`${channel} takes ${count} argument(s), got ${args.length}`);
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return typeof value === 'object' ? (value.constructor?.name ?? 'an object') : typeof value;
}

/** A file name with any folder part removed, so a page cannot steer the dialog elsewhere. */
function suggestedFileName(value: unknown, extension?: string): string {
  const name = basename(expectString(value, 'suggestedName', MAX_NAME_LENGTH).replace(/\\/g, '/')) || 'Untitled';
  return extension && extname(name).toLowerCase() !== extension ? `${name}${extension}` : name;
}

/**
 * One handler per invoke channel. OneNote files can be listed and read only
 * inside a folder this session's folder picker or backup lookup returned, so a
 * page cannot read notebooks from anywhere else on disk.
 */
export function createHandlers(deps: HandlerDeps): Record<InvokeChannel, Handler> {
  const grantedFolders: string[] = [];

  async function grant(folder: string | null): Promise<string | null> {
    if (folder !== null) grantedFolders.push(await realpath(folder));
    return folder;
  }

  async function requireGranted(folder: string): Promise<void> {
    const real = await realpath(folder);
    const inside = grantedFolders.some((granted) => {
      const rel = relative(granted, real);
      return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
    });
    if (!inside) {
      throw new Error(`"${folder}" is not inside a folder chosen in the folder picker or found as the OneNote backup folder`);
    }
  }

  return {
    async [CHANNELS.saveFile](host, args) {
      expectArgCount(args, 2, CHANNELS.saveFile);
      const name = suggestedFileName(args[0]);
      const bytes = expectBytes(args[1], 'bytes');
      const extension = extname(name).slice(1);
      const filters = extension ? [{ name: extension.toUpperCase(), extensions: [extension] }] : [];
      const path = await host.showSaveDialog(join(deps.saveFolder, name), filters);
      if (path === null) return false;
      await deps.writeFile(path, bytes);
      return true;
    },

    async [CHANNELS.savePdf](host, args) {
      expectArgCount(args, 1, CHANNELS.savePdf);
      const name = suggestedFileName(args[0], '.pdf');
      const path = await host.showSaveDialog(join(deps.saveFolder, name), [{ name: 'PDF', extensions: ['pdf'] }]);
      if (path === null) return false;
      await deps.writeFile(path, await host.printToPdf());
      return true;
    },

    async [CHANNELS.findOneNoteBackups](_host, args) {
      expectArgCount(args, 0, CHANNELS.findOneNoteBackups);
      return grant(await findOneNoteBackups(deps.platform, deps.homeDir, deps.env));
    },

    async [CHANNELS.pickFolder](host, args) {
      expectArgCount(args, 0, CHANNELS.pickFolder);
      return grant(await host.showFolderDialog());
    },

    async [CHANNELS.listOneNoteFiles](_host, args) {
      expectArgCount(args, 1, CHANNELS.listOneNoteFiles);
      const folder = expectAbsolutePath(args[0], 'folder');
      await requireGranted(folder);
      return listOneNoteFiles(folder);
    },

    async [CHANNELS.readOneNoteFile](_host, args) {
      expectArgCount(args, 2, CHANNELS.readOneNoteFile);
      const folder = expectAbsolutePath(args[0], 'folder');
      const path = expectString(args[1], 'path', MAX_PATH_LENGTH);
      await requireGranted(folder);
      return readOneNoteFile(folder, path);
    },
  };
}
