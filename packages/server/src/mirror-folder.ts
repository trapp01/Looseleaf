/**
 * A mirror folder on disk: reading its mirror manifest and applying a plan
 * to it. Every path is checked to land inside the folder, following
 * symlinks, before anything is written or removed. A removal is done only
 * when the manifest on disk lists the path, so a file the mirror never wrote
 * survives whatever plan arrives. Files are written to a dot-prefixed temp
 * name beside the target, fsynced and renamed into place; the manifest goes
 * last. This file knows nothing about the server, so the desktop shell can
 * use it for a folder the person chose.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, open, readdir, readFile, realpath, rename, rmdir, rm, unlink } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import {
  isSafeMirrorPath,
  MIRROR_MANIFEST_FILE,
  mirrorOwnedPaths,
  parseMirrorManifest,
  serializeMirrorManifest,
  type MirrorManifest,
} from '@looseleaf/model/mirror-manifest';
import type { MirrorPlan } from '@looseleaf/model';

/** Temp files start with this. One left by a crash is removed by the next instance's first apply, from the folders the manifest lists. */
export const MIRROR_TEMP_PREFIX = '.looseleaf-tmp-';

/** The bytes of the blob an asset copies, or null when the replica does not hold it. */
export type MirrorBlobReader = (hash: string) => Promise<Uint8Array | AsyncIterable<Uint8Array> | null>;

export interface MirrorApplyResult {
  written: number;
  removed: number;
  /** Plan paths that were not touched, each with the reason. */
  refused: Array<{ path: string; reason: string }>;
  /** False when the manifest on disk already held these bytes. */
  manifestWritten: boolean;
}

export class MirrorFolder {
  readonly root: string;
  private cleaned = false;

  constructor(root: string) {
    this.root = resolve(root);
  }

  /** The manifest at the root, or null when it is missing or unreadable. An unreadable one is logged. */
  async readManifest(): Promise<MirrorManifest | null> {
    const { manifest, problem } = await this.readManifestFile();
    if (problem !== null) console.warn(`The mirror manifest in ${this.root} ${problem}; the next plan writes every file again`);
    return manifest;
  }

  /**
   * Applies removals, then asset and page writes, then the manifest. Paths
   * outside the folder, and removals the manifest on disk does not list,
   * are refused and reported. Throws on a failed write; files already
   * renamed stay and the manifest on disk is left as it was.
   */
  async apply(plan: Pick<MirrorPlan, 'writes' | 'assets' | 'removals' | 'manifest'>, readBlob: MirrorBlobReader): Promise<MirrorApplyResult> {
    await mkdir(this.root, { recursive: true });
    const realRoot = await realpath(this.root);
    const { manifest: onDisk, bytes: onDiskBytes } = await this.readManifestFile();
    const owned = onDisk === null ? new Set<string>() : mirrorOwnedPaths(onDisk);
    if (!this.cleaned) {
      // Only folders the mirror wrote into are searched; the rest of a chosen folder is never walked.
      const folders = new Set([this.root, ...[...owned].map((path) => dirname(resolve(this.root, ...path.split('/'))))]);
      for (const folder of folders) {
        if (await isInside(folder, realRoot)) await removeTempFiles(folder);
      }
      this.cleaned = true;
    }
    const result: MirrorApplyResult = { written: 0, removed: 0, refused: [], manifestWritten: false };
    const refuse = (path: string, reason: string) => result.refused.push({ path, reason });

    for (const path of plan.removals) {
      const target = this.target(path);
      if (target === null) refuse(path, 'it does not stay inside the mirror folder');
      else if (!owned.has(path)) refuse(path, 'the mirror manifest on disk does not list it');
      else if (!(await isInside(dirname(target), realRoot))) refuse(path, 'its folder resolves outside the mirror folder');
      else {
        const problem = await this.remove(target);
        if (problem === null) result.removed += 1;
        else refuse(path, problem);
      }
    }

    const touched = new Set<string>();
    const write = async (path: string, data: () => Promise<Uint8Array | AsyncIterable<Uint8Array>>) => {
      const target = this.target(path);
      if (target === null) return refuse(path, 'it does not stay inside the mirror folder');
      // Checked before the folder is made, so a symlink above it cannot have folders created outside the root.
      if (!(await isInside(await nearestExisting(dirname(target)), realRoot))) return refuse(path, 'its folder resolves outside the mirror folder');
      await mkdir(dirname(target), { recursive: true });
      await writeAtomically(target, await data());
      touched.add(dirname(target));
      result.written += 1;
    };
    // Assets go first, so a page file never links to an asset that is not there yet.
    for (const asset of plan.assets) {
      await write(asset.path, async () => {
        const bytes = await readBlob(asset.hash);
        if (bytes === null) throw new Error(`Blob ${asset.hash} for mirror file ${asset.path} is not in the replica`);
        return bytes;
      });
    }
    for (const file of plan.writes) await write(file.path, async () => file.data);
    for (const folder of touched) await syncFolder(folder);

    const next = serializeMirrorManifest(plan.manifest);
    if (onDiskBytes === null || !Buffer.from(next).equals(onDiskBytes)) {
      await writeAtomically(join(this.root, MIRROR_MANIFEST_FILE), next);
      await syncFolder(this.root);
      result.manifestWritten = true;
    }
    return result;
  }

  /**
   * The text of the file at a manifest path, or null when it is not on disk.
   * Throws when the path is unsafe, names the manifest, or resolves outside
   * the folder once symlinks are followed.
   */
  async readText(path: string): Promise<string | null> {
    const target = this.target(path);
    if (target === null) throw new Error(`Mirror path ${JSON.stringify(path)} does not stay inside ${this.root}`);
    try {
      const real = await realpath(target);
      const realRoot = await realpath(this.root);
      if (!real.startsWith(realRoot + sep)) throw new Error(`Mirror path ${JSON.stringify(path)} resolves outside ${this.root}`);
      return await readFile(real, 'utf8');
    } catch (error) {
      if (code(error) === 'ENOENT' || code(error) === 'ENOTDIR') return null;
      throw error;
    }
  }

  /** The absolute path for a plan path, or null when it is unsafe or names the manifest. */
  private target(path: string): string | null {
    if (!isSafeMirrorPath(path)) return null;
    const target = resolve(this.root, ...path.split('/'));
    if (!target.startsWith(this.root + sep) || target === join(this.root, MIRROR_MANIFEST_FILE)) return null;
    return target;
  }

  /** Removes the file, then each folder above it that is now empty. Resolves to a problem, or null. */
  private async remove(target: string): Promise<string | null> {
    try {
      await unlink(target);
    } catch (error) {
      if (code(error) !== 'ENOENT') return `it could not be removed (${(error as Error).message})`;
    }
    for (let folder = dirname(target); folder.startsWith(this.root + sep); folder = dirname(folder)) {
      try {
        await rmdir(folder);
      } catch (error) {
        const reason = code(error);
        if (reason === 'ENOTEMPTY' || reason === 'EEXIST' || reason === 'ENOENT') break;
        return `its folder ${folder} could not be removed (${(error as Error).message})`;
      }
    }
    return null;
  }

  private async readManifestFile(): Promise<{ manifest: MirrorManifest | null; bytes: Buffer | null; problem: string | null }> {
    let bytes: Buffer;
    try {
      bytes = await readFile(join(this.root, MIRROR_MANIFEST_FILE));
    } catch (error) {
      if (code(error) === 'ENOENT') return { manifest: null, bytes: null, problem: null };
      return { manifest: null, bytes: null, problem: `could not be read (${(error as Error).message})` };
    }
    const manifest = parseMirrorManifest(bytes);
    return { manifest, bytes, problem: manifest === null ? 'is not a manifest this version reads' : null };
  }
}

async function writeAtomically(target: string, data: Uint8Array | AsyncIterable<Uint8Array>): Promise<void> {
  const tmp = join(dirname(target), `${MIRROR_TEMP_PREFIX}${randomBytes(6).toString('hex')}`);
  try {
    const file = await open(tmp, 'w');
    try {
      await file.writeFile(data);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(tmp, target);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

/** True when `folder`, with symlinks followed, is the root or inside it. A folder that is gone is inside. */
async function isInside(folder: string, realRoot: string): Promise<boolean> {
  let real: string;
  try {
    real = await realpath(folder);
  } catch (error) {
    if (code(error) === 'ENOENT') return true;
    throw error;
  }
  return real === realRoot || real.startsWith(realRoot + sep);
}

/** The folder itself, or the closest folder above it that exists. */
async function nearestExisting(folder: string): Promise<string> {
  for (;;) {
    try {
      await realpath(folder);
      return folder;
    } catch (error) {
      if (code(error) !== 'ENOENT' || dirname(folder) === folder) throw error;
      folder = dirname(folder);
    }
  }
}

/** Removes temp files directly in the folder. A folder that is gone has none. */
async function removeTempFiles(folder: string): Promise<void> {
  let entries;
  try {
    entries = await readdir(folder, { withFileTypes: true });
  } catch (error) {
    if (code(error) === 'ENOENT' || code(error) === 'ENOTDIR') return;
    throw error;
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name.startsWith(MIRROR_TEMP_PREFIX)) await unlink(join(folder, entry.name));
  }
}

/** Makes renames in the folder durable where the platform can fsync a folder. */
async function syncFolder(path: string): Promise<void> {
  let folder;
  try {
    folder = await open(path, 'r');
  } catch (error) {
    if (code(error) === 'EISDIR' || code(error) === 'EPERM') return;
    throw error;
  }
  try {
    await folder.sync();
  } catch (error) {
    if (code(error) !== 'EINVAL' && code(error) !== 'EPERM' && code(error) !== 'EISDIR') throw error;
  } finally {
    await folder.close();
  }
}

function code(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}
