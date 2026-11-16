import { mkdir, readdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MIRROR_MANIFEST_FILE,
  serializeMirrorManifest,
  type MirrorManifest,
  type MirrorPage,
} from '@looseleaf/model';
import { MirrorFolder, MIRROR_TEMP_PREFIX } from '../src/mirror-folder.js';
import { tempDir } from './harness.js';

const HASH = 'a'.repeat(64);
const encode = (text: string) => new TextEncoder().encode(text);

function page(path: string, assets: string[] = []): MirrorPage {
  return {
    id: path,
    notebookId: 'nb',
    notebook: 'Notebook',
    sectionId: 's',
    section: ['Section'],
    title: path,
    level: 0,
    path,
    hash: HASH,
    assets,
    missingBlobs: [],
  };
}

function manifest(...pages: MirrorPage[]): MirrorManifest {
  return { format: 'looseleaf-mirror', version: 1, pages };
}

const noBlobs = async () => null;

async function folderWith(files: Record<string, string>, onDisk: MirrorManifest | null) {
  const root = join(await tempDir(), 'mirror');
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), text);
  }
  if (onDisk) {
    await mkdir(root, { recursive: true });
    await writeFile(join(root, MIRROR_MANIFEST_FILE), serializeMirrorManifest(onDisk));
  }
  return { root, folder: new MirrorFolder(root) };
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

describe('a mirror folder', () => {
  it('writes assets, then pages, then the manifest, and reads the manifest back', async () => {
    const { root, folder } = await folderWith({}, null);
    expect(await folder.readManifest()).toBeNull();
    const next = manifest(page('Nb/S/Page.md', [`${HASH}.png`]));
    let anythingBeforeAsset: boolean | null = null;
    const result = await folder.apply(
      { writes: [{ path: 'Nb/S/Page.md', data: encode('# Page\n') }], assets: [{ path: `assets/${HASH}.png`, hash: HASH }], removals: [], manifest: next },
      async () => {
        anythingBeforeAsset = (await exists(join(root, MIRROR_MANIFEST_FILE))) || (await exists(join(root, 'Nb/S/Page.md')));
        return encode('png bytes');
      },
    );
    expect(anythingBeforeAsset).toBe(false);
    expect(result).toEqual({ written: 2, removed: 0, refused: [], manifestWritten: true });
    expect(await readFile(join(root, 'Nb/S/Page.md'), 'utf8')).toBe('# Page\n');
    expect(await readFile(join(root, `assets/${HASH}.png`), 'utf8')).toBe('png bytes');
    expect(await folder.readManifest()).toEqual(next);
  });

  it('leaves the manifest as it was when a write fails', async () => {
    const before = manifest(page('Old.md'));
    const { root, folder } = await folderWith({ 'Old.md': 'old' }, before);
    const plan = { writes: [{ path: 'New.md', data: encode('new') }], assets: [{ path: `assets/${HASH}`, hash: HASH }], removals: [], manifest: manifest(page('New.md')) };
    await expect(folder.apply(plan, noBlobs)).rejects.toThrow(/Blob a+ for mirror file assets\/a+ is not in the replica/);
    expect(await folder.readManifest()).toEqual(before);
    expect(await exists(join(root, 'New.md'))).toBe(false);
    expect((await readdir(root)).filter((name) => name.startsWith(MIRROR_TEMP_PREFIX))).toEqual([]);
  });

  it('refuses paths that leave the folder', async () => {
    const parent = await tempDir();
    const root = join(parent, 'mirror');
    const folder = new MirrorFolder(root);
    const outside = join(parent, 'outside.md');
    await writeFile(outside, 'keep');
    const bad = ['../x.md', '../outside.md', join(parent, 'abs.md'), '/etc/looseleaf.md', 'a/../../x.md', 'a//b.md', 'C:/x.md', 'a\\..\\..\\x.md', MIRROR_MANIFEST_FILE];
    const result = await folder.apply(
      { writes: bad.map((path) => ({ path, data: encode('bad') })), assets: [], removals: bad, manifest: manifest() },
      noBlobs,
    );
    expect(result.written).toBe(0);
    expect(result.removed).toBe(0);
    expect(result.refused.map((r) => r.path)).toEqual([...bad, ...bad]);
    expect(await readFile(outside, 'utf8')).toBe('keep');
    expect(await readdir(parent)).toEqual(['mirror', 'outside.md']);
    expect(await readdir(root)).toEqual([MIRROR_MANIFEST_FILE]);
  });

  it('refuses to write or remove through a symlinked folder that leads outside', async () => {
    const parent = await tempDir();
    const elsewhere = join(parent, 'elsewhere');
    await mkdir(elsewhere);
    await writeFile(join(elsewhere, 'Page.md'), 'not ours');
    const root = join(parent, 'mirror');
    await mkdir(root);
    await symlink(elsewhere, join(root, 'Nb'));
    await writeFile(join(root, MIRROR_MANIFEST_FILE), serializeMirrorManifest(manifest(page('Nb/Page.md'))));
    const result = await new MirrorFolder(root).apply(
      { writes: [{ path: 'Nb/Other.md', data: encode('x') }], assets: [], removals: ['Nb/Page.md'], manifest: manifest() },
      noBlobs,
    );
    expect(result.refused.map((r) => r.reason)).toEqual([
      'its folder resolves outside the mirror folder',
      'its folder resolves outside the mirror folder',
    ]);
    expect(await readdir(elsewhere)).toEqual(['Page.md']);
  });

  it('removes only what the manifest on disk lists and keeps every other file', async () => {
    const { root, folder } = await folderWith(
      { 'Nb/S/Page.md': 'ours', 'Nb/S/mine.txt': 'theirs', 'notes.txt': 'theirs', 'Nb/Other.md': 'not listed' },
      manifest(page('Nb/S/Page.md')),
    );
    const result = await folder.apply(
      { writes: [], assets: [], removals: ['Nb/S/Page.md', 'notes.txt', 'Nb/Other.md'], manifest: manifest() },
      noBlobs,
    );
    expect(result.removed).toBe(1);
    expect(result.refused).toEqual([
      { path: 'notes.txt', reason: 'the mirror manifest on disk does not list it' },
      { path: 'Nb/Other.md', reason: 'the mirror manifest on disk does not list it' },
    ]);
    expect(await exists(join(root, 'Nb/S/Page.md'))).toBe(false);
    for (const path of ['Nb/S/mine.txt', 'notes.txt', 'Nb/Other.md']) expect(await exists(join(root, path))).toBe(true);
  });

  it('removes nothing when there is no manifest on disk', async () => {
    const { root, folder } = await folderWith({ 'Nb/Page.md': 'kept' }, null);
    const result = await folder.apply({ writes: [], assets: [], removals: ['Nb/Page.md'], manifest: manifest() }, noBlobs);
    expect(result.refused).toHaveLength(1);
    expect(await exists(join(root, 'Nb/Page.md'))).toBe(true);
  });

  it('removes folders left empty and keeps folders that still hold something', async () => {
    const { root, folder } = await folderWith(
      { 'A/G/S/One.md': '1', 'B/S/Two.md': '2', 'B/S/keep.txt': 'theirs' },
      manifest(page('A/G/S/One.md'), page('B/S/Two.md')),
    );
    await folder.apply({ writes: [], assets: [], removals: ['A/G/S/One.md', 'B/S/Two.md'], manifest: manifest() }, noBlobs);
    expect((await readdir(root)).sort()).toEqual([MIRROR_MANIFEST_FILE, 'B']);
    expect(await readdir(join(root, 'B/S'))).toEqual(['keep.txt']);
  });

  it('cleans up temp files a crash left behind, in the folders the manifest lists only', async () => {
    const listed = manifest(page('Nb/S/Page.md'));
    const { root, folder } = await folderWith(
      {
        [`${MIRROR_TEMP_PREFIX}abc`]: 'partial',
        'Nb/S/Page.md': 'x',
        [`Nb/S/${MIRROR_TEMP_PREFIX}def`]: 'partial',
        'Nb/S/.hidden': 'theirs',
        [`Theirs/${MIRROR_TEMP_PREFIX}ghi`]: 'not searched',
      },
      listed,
    );
    await folder.apply({ writes: [], assets: [], removals: [], manifest: listed }, noBlobs);
    expect(await readdir(root)).toEqual([MIRROR_MANIFEST_FILE, 'Nb', 'Theirs']);
    expect(await readdir(join(root, 'Nb/S'))).toEqual(['.hidden', 'Page.md']);
    expect(await readdir(join(root, 'Theirs'))).toEqual([`${MIRROR_TEMP_PREFIX}ghi`]);
  });

  it('makes no folder outside the root when a symlink sits above a new path', async () => {
    const parent = await tempDir();
    const elsewhere = join(parent, 'elsewhere');
    await mkdir(elsewhere);
    const root = join(parent, 'mirror');
    await mkdir(root);
    await symlink(elsewhere, join(root, 'Nb'));
    const result = await new MirrorFolder(root).apply(
      { writes: [{ path: 'Nb/New section/Page.md', data: encode('x') }], assets: [], removals: [], manifest: manifest() },
      noBlobs,
    );
    expect(result.refused.map((r) => r.path)).toEqual(['Nb/New section/Page.md']);
    expect(await readdir(elsewhere)).toEqual([]);
  });

  it('does not rewrite a manifest that has not changed', async () => {
    const same = manifest(page('Page.md'));
    const { root, folder } = await folderWith({ 'Page.md': 'x' }, same);
    const before = await stat(join(root, MIRROR_MANIFEST_FILE));
    const result = await folder.apply({ writes: [], assets: [], removals: [], manifest: same }, noBlobs);
    expect(result.manifestWritten).toBe(false);
    expect((await stat(join(root, MIRROR_MANIFEST_FILE))).ino).toBe(before.ino);
  });

  it('reads a damaged manifest as none', async () => {
    const { root, folder } = await folderWith({ [MIRROR_MANIFEST_FILE]: '{"format":"looseleaf-mirror","version":1,"pages":[{}]}' }, null);
    expect(await folder.readManifest()).toBeNull();
    await writeFile(join(root, MIRROR_MANIFEST_FILE), 'garbage');
    expect(await folder.readManifest()).toBeNull();
  });
});
