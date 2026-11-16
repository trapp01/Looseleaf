/**
 * The mirror manifest: the file at a mirror's root that lists every page in
 * it, in notebook order, and so every file the mirror owns. Hosts read it to
 * plan the next change and remove only what it lists; anything that does not
 * parse as the current version counts as no manifest at all.
 */
import { strFromU8, strToU8 } from 'fflate';
import type { PageLevel } from '../notebook.js';

/** The manifest's file name at the mirror's root. */
export const MIRROR_MANIFEST_FILE = '.looseleaf-mirror.json';
/** The folder at the mirror's root that holds every page's pictures and files. */
export const MIRROR_ASSETS_FOLDER = 'assets';

const FORMAT = 'looseleaf-mirror';
const VERSION = 1;

export interface MirrorManifest {
  format: 'looseleaf-mirror';
  version: 1;
  /** Every live page, library order then tree order. */
  pages: MirrorPage[];
}

export interface MirrorPage {
  id: string;
  notebookId: string;
  notebook: string;
  sectionId: string;
  /** The names of the groups above the section and the section itself, outermost first. */
  section: string[];
  title: string;
  level: PageLevel;
  /** The page file, relative to the mirror's root, with `/` between segments. */
  path: string;
  /** SHA-256 hex of the page file's bytes. */
  hash: string;
  /** File names in the assets folder that the page links to. */
  assets: string[];
  /** Hashes of blobs the page references that the replica did not hold when it was rendered. */
  missingBlobs: string[];
}

const HASH = /^[0-9a-f]{64}$/;
const ASSET_NAME = /^[0-9a-f]{64}(\.[a-z0-9]{1,8})?$/;

/** True for a hash a blob can be named by. Anything else is never fetched or written. */
export function isMirrorBlobHash(value: string): boolean {
  return HASH.test(value);
}

/**
 * True for a relative `/`-separated path with no empty, `.` or `..` segment
 * and no backslash, drive letter or leading `/`. Every path a plan or manifest
 * holds passes this.
 */
export function isSafeMirrorPath(path: string): boolean {
  if (path === '' || path.includes('\\') || path.includes('\0') || /^[a-zA-Z]:/.test(path)) return false;
  return path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

/** Every path the manifest lists: its page files and `assets/<name>` for each asset a page links to. */
export function mirrorOwnedPaths(manifest: MirrorManifest): Set<string> {
  const paths = new Set<string>();
  for (const page of manifest.pages) {
    paths.add(page.path);
    for (const asset of page.assets) paths.add(`${MIRROR_ASSETS_FOLDER}/${asset}`);
  }
  return paths;
}

export function serializeMirrorManifest(manifest: MirrorManifest): Uint8Array {
  return strToU8(JSON.stringify(manifest, null, 2) + '\n');
}

/**
 * The manifest in the bytes or text, or null for anything that is not a
 * well-formed manifest of the current version with safe paths. Never throws.
 */
export function parseMirrorManifest(input: Uint8Array | string): MirrorManifest | null {
  let value: unknown;
  try {
    value = JSON.parse(typeof input === 'string' ? input : strFromU8(input));
  } catch {
    return null;
  }
  if (!isRecord(value) || value.format !== FORMAT || value.version !== VERSION || !Array.isArray(value.pages)) return null;
  const pages: MirrorPage[] = [];
  for (const page of value.pages) {
    const parsed = parsePage(page);
    if (parsed === null) return null;
    pages.push(parsed);
  }
  return { format: FORMAT, version: VERSION, pages };
}

function parsePage(value: unknown): MirrorPage | null {
  if (!isRecord(value)) return null;
  const { id, notebookId, notebook, sectionId, section, title, level, path, hash, assets, missingBlobs } = value;
  if (
    typeof id !== 'string' ||
    typeof notebookId !== 'string' ||
    typeof notebook !== 'string' ||
    typeof sectionId !== 'string' ||
    !isStringArray(section) ||
    typeof title !== 'string' ||
    (level !== 0 && level !== 1 && level !== 2) ||
    typeof path !== 'string' ||
    !isSafeMirrorPath(path) ||
    typeof hash !== 'string' ||
    !HASH.test(hash) ||
    !isStringArray(assets) ||
    !assets.every((name) => ASSET_NAME.test(name)) ||
    !isStringArray(missingBlobs) ||
    !missingBlobs.every((blob) => HASH.test(blob))
  ) {
    return null;
  }
  return { id, notebookId, notebook, sectionId, section, title, level, path, hash, assets, missingBlobs };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}
