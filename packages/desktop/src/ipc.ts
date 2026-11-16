/**
 * What the main process does for each bridge call: argument checks, the
 * folder grants that limit OneNote reads, the remembered mirror folder, and
 * the work itself. Electron objects arrive through `ShellHost` and
 * `HandlerDeps`, so this runs in Node tests. The page's origin is checked by
 * the caller before a handler runs.
 */
import { readdir, realpath, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, sep } from 'node:path';
import { parseMirrorManifest, serializeMirrorManifest, type MirrorManifest } from '@looseleaf/model/mirror-manifest';
import { MirrorFolder } from '@looseleaf/server/mirror-folder';
import { CHANNELS, type InvokeChannel } from './channels.js';
import { loadMirrorFolder, saveMirrorFolder } from './mirror-setting.js';
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
  /** Writes a file chosen in a save dialog; used by saveFile and savePdf. Mirror files go through `MirrorFolder`. */
  writeFile(path: string, bytes: Uint8Array): Promise<void>;
  /** The JSON file in user data that remembers the mirror folder across launches. */
  mirrorSettingFile: string;
}

export type Handler = (host: ShellHost, args: unknown[]) => Promise<unknown>;

const MAX_NAME_LENGTH = 255;
const MAX_PATH_LENGTH = 4096;
/** Upper bounds on one applyMirrorBatch call. The web client sends batches far below them. */
const MAX_MIRROR_BATCH_ENTRIES = 5000;
const MAX_MIRROR_BATCH_BYTES = 512 * 1024 * 1024;
const BLOB_HASH_LENGTH = 64;

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

export function expectArray(value: unknown, what: string, maxLength: number): unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${what} must be an array, got ${describe(value)}`);
  if (value.length > maxLength) throw new TypeError(`${what} must hold at most ${maxLength} items, got ${value.length}`);
  return value;
}

export function expectRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || value instanceof Uint8Array) {
    throw new TypeError(`${what} must be an object, got ${describe(value)}`);
  }
  return value as Record<string, unknown>;
}

/** One applyMirrorBatch argument after its checks. Paths are checked by `MirrorFolder`, not here. */
export interface MirrorBatchArgs {
  removals: string[];
  assets: Array<{ path: string; hash: string; bytes: Uint8Array }>;
  pages: Array<{ path: string; bytes: Uint8Array }>;
  manifest: MirrorManifest;
}

export function expectMirrorBatch(value: unknown): MirrorBatchArgs {
  const batch = expectRecord(value, 'batch');
  const removals = expectArray(batch.removals, 'batch.removals', MAX_MIRROR_BATCH_ENTRIES).map((path, i) =>
    expectString(path, `batch.removals[${i}]`, MAX_PATH_LENGTH),
  );
  const assets = expectArray(batch.assets, 'batch.assets', MAX_MIRROR_BATCH_ENTRIES).map((item, i) => {
    const asset = expectRecord(item, `batch.assets[${i}]`);
    return {
      path: expectString(asset.path, `batch.assets[${i}].path`, MAX_PATH_LENGTH),
      hash: expectString(asset.hash, `batch.assets[${i}].hash`, BLOB_HASH_LENGTH),
      bytes: expectBytes(asset.bytes, `batch.assets[${i}].bytes`),
    };
  });
  const pages = expectArray(batch.pages, 'batch.pages', MAX_MIRROR_BATCH_ENTRIES).map((item, i) => {
    const page = expectRecord(item, `batch.pages[${i}]`);
    return {
      path: expectString(page.path, `batch.pages[${i}].path`, MAX_PATH_LENGTH),
      bytes: expectBytes(page.bytes, `batch.pages[${i}].bytes`),
    };
  });
  const manifestBytes = expectBytes(batch.manifest, 'batch.manifest');
  const entries = removals.length + assets.length + pages.length;
  if (entries > MAX_MIRROR_BATCH_ENTRIES) {
    throw new TypeError(`batch must hold at most ${MAX_MIRROR_BATCH_ENTRIES} removals and files, got ${entries}`);
  }
  const bytes = [...assets, ...pages].reduce((sum, file) => sum + file.bytes.length, manifestBytes.length);
  if (bytes > MAX_MIRROR_BATCH_BYTES) throw new TypeError(`batch must hold at most ${MAX_MIRROR_BATCH_BYTES} bytes, got ${bytes}`);
  const manifest = parseMirrorManifest(manifestBytes);
  if (manifest === null) throw new TypeError('batch.manifest is not a mirror manifest this version reads');
  return { removals, assets, pages, manifest };
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
  const remembered = loadMirrorFolder(deps.mirrorSettingFile);
  let mirror: MirrorFolder | null = remembered === null ? null : new MirrorFolder(remembered);

  /** The remembered mirror folder, once it is known to be a folder that is there. The setting is never dropped here. */
  async function mirrorFolder(): Promise<MirrorFolder> {
    if (mirror === null) throw new Error('No mirror folder is chosen');
    const folder = mirror;
    let isFolder: boolean;
    try {
      isFolder = (await stat(folder.root)).isDirectory();
    } catch {
      throw new Error(`${folder.root} does not exist`);
    }
    if (!isFolder) throw new Error(`${folder.root} is not a folder`);
    return folder;
  }

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

    async [CHANNELS.chooseMirrorFolder](host, args) {
      expectArgCount(args, 0, CHANNELS.chooseMirrorFolder);
      const folder = await host.showFolderDialog();
      if (folder === null) return { status: 'cancelled' };
      const chosen = new MirrorFolder(folder);
      // A plan overwrites whatever is at its paths, so a folder holding other files is refused.
      const names = (await readdir(chosen.root)).filter((name) => !name.startsWith('.'));
      if (names.length > 0 && (await chosen.readManifest()) === null) return { status: 'not-empty', folder: chosen.root };
      saveMirrorFolder(deps.mirrorSettingFile, chosen.root);
      mirror = chosen;
      return { status: 'chosen', folder: chosen.root };
    },

    async [CHANNELS.mirrorFolder](_host, args) {
      expectArgCount(args, 0, CHANNELS.mirrorFolder);
      return mirror?.root ?? null;
    },

    async [CHANNELS.stopMirroring](_host, args) {
      expectArgCount(args, 0, CHANNELS.stopMirroring);
      saveMirrorFolder(deps.mirrorSettingFile, null);
      mirror = null;
    },

    async [CHANNELS.readMirrorManifest](_host, args) {
      expectArgCount(args, 0, CHANNELS.readMirrorManifest);
      const manifest = await (await mirrorFolder()).readManifest();
      return manifest === null ? null : serializeMirrorManifest(manifest);
    },

    async [CHANNELS.applyMirrorBatch](_host, args) {
      expectArgCount(args, 1, CHANNELS.applyMirrorBatch);
      const batch = expectMirrorBatch(args[0]);
      const folder = await mirrorFolder();
      const blobs = new Map(batch.assets.map((asset) => [asset.hash, asset.bytes]));
      const writes = batch.pages.map((page) => ({ path: page.path, data: page.bytes }));
      return folder.apply(
        { removals: batch.removals, assets: batch.assets, writes, manifest: batch.manifest },
        async (hash) => blobs.get(hash) ?? null,
      );
    },
  };
}
