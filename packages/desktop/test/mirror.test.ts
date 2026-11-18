import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  MIRROR_MANIFEST_FILE,
  parseMirrorManifest,
  serializeMirrorManifest,
  type MirrorManifest,
  type MirrorPage,
} from '@looseleaf/model/mirror-manifest';
import { CHANNELS } from '../src/channels.js';
import { createHandlers, type ShellHost } from '../src/ipc.js';
import { loadMirrorFolder, saveMirrorFolder } from '../src/mirror-setting.js';

const text = (value: string) => new TextEncoder().encode(value);
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

function temp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `looseleaf-${prefix}-`));
}

/** Handlers over a user data folder; calling `restart` makes new handlers on the same folder, as a relaunch does. */
function shell(options: { userData?: string; picked?: string | null } = {}) {
  const userData = options.userData ?? temp('user-data');
  const settingFile = join(userData, 'mirror-folder.json');
  const host = {
    showSaveDialog: vi.fn(async () => null),
    showFolderDialog: vi.fn(async () => (options.picked === undefined ? null : options.picked)),
    printToPdf: vi.fn(async () => new Uint8Array()),
  } satisfies ShellHost;
  const handlers = createHandlers({
    platform: 'darwin',
    homeDir: '/nowhere',
    env: {},
    saveFolder: '/nowhere',
    writeFile: vi.fn(async () => undefined),
    mirrorSettingFile: settingFile,
    update: { readyVersion: () => null, restart: () => undefined },
  });
  const call = (channel: (typeof CHANNELS)[keyof typeof CHANNELS], ...args: unknown[]) =>
    handlers[channel as keyof typeof handlers](host, args);
  return { userData, settingFile, host, call, restart: (picked?: string | null) => shell({ userData, picked }) };
}

function entry(path: string, bytes: Uint8Array, assets: string[] = []): MirrorPage {
  return {
    id: `id-${path}`,
    notebookId: 'nb',
    notebook: 'Work',
    sectionId: 'sec',
    section: ['Projects'],
    title: path,
    level: 0,
    path,
    hash: sha(bytes),
    assets,
    missingBlobs: [],
  };
}

function manifest(pages: MirrorPage[]): MirrorManifest {
  return { format: 'looseleaf-mirror', version: 1, pages };
}

function batch(parts: {
  removals?: string[];
  assets?: Array<{ path: string; hash: string; bytes: Uint8Array }>;
  pages?: Array<{ path: string; bytes: Uint8Array }>;
  manifest: MirrorManifest;
}) {
  return {
    removals: parts.removals ?? [],
    assets: parts.assets ?? [],
    pages: parts.pages ?? [],
    manifest: serializeMirrorManifest(parts.manifest),
  };
}

function filesUnder(folder: string): string[] {
  return readdirSync(folder, { recursive: true, withFileTypes: true })
    .filter((item) => item.isFile())
    .map((item) => join(item.parentPath, item.name).slice(folder.length + 1).split('\\').join('/'))
    .sort();
}

describe('mirror setting file', () => {
  it('round-trips a folder and reads a missing or damaged file as none', () => {
    const file = join(temp('user-data'), 'mirror-folder.json');
    expect(loadMirrorFolder(file)).toBeNull();
    saveMirrorFolder(file, '/Users/ann/Mirror');
    expect(loadMirrorFolder(file)).toBe('/Users/ann/Mirror');
    saveMirrorFolder(file, null);
    expect(loadMirrorFolder(file)).toBeNull();
    for (const damaged of ['{oops', '[]', '{"folder":"relative/path"}', '{"folder":7}']) {
      writeFileSync(file, damaged);
      expect(loadMirrorFolder(file)).toBeNull();
    }
  });
});

describe('choosing the mirror folder', () => {
  it('remembers the chosen folder across a restart and forgets it on stop, leaving the files', async () => {
    const folder = temp('mirror');
    const first = shell({ picked: folder });
    expect(await first.call(CHANNELS.mirrorFolder)).toBeNull();
    expect(await first.call(CHANNELS.chooseMirrorFolder)).toEqual({ status: 'chosen', folder });
    expect(first.host.showFolderDialog).toHaveBeenCalledTimes(1);

    const second = first.restart();
    expect(await second.call(CHANNELS.mirrorFolder)).toBe(folder);
    const bytes = text('# Agenda\n');
    await second.call(CHANNELS.applyMirrorBatch, batch({ pages: [{ path: 'Agenda.md', bytes }], manifest: manifest([entry('Agenda.md', bytes)]) }));
    await second.call(CHANNELS.stopMirroring);
    expect(await second.call(CHANNELS.mirrorFolder)).toBeNull();

    const third = second.restart();
    expect(await third.call(CHANNELS.mirrorFolder)).toBeNull();
    expect(filesUnder(folder)).toEqual([MIRROR_MANIFEST_FILE, 'Agenda.md']);
  });

  it('changes nothing when the picker is cancelled', async () => {
    const folder = temp('mirror');
    const first = shell({ picked: folder });
    await first.call(CHANNELS.chooseMirrorFolder);
    const saved = readFileSync(first.settingFile, 'utf8');
    const cancelled = first.restart(null);
    expect(await cancelled.call(CHANNELS.chooseMirrorFolder)).toEqual({ status: 'cancelled' });
    expect(await cancelled.call(CHANNELS.mirrorFolder)).toBe(folder);
    expect(readFileSync(first.settingFile, 'utf8')).toBe(saved);

    const never = shell({ picked: null });
    expect(await never.call(CHANNELS.chooseMirrorFolder)).toEqual({ status: 'cancelled' });
    expect(existsSync(never.settingFile)).toBe(false);
  });

  it('accepts a folder holding only dot files, or one that already holds a mirror', async () => {
    const dotted = temp('mirror');
    writeFileSync(join(dotted, '.DS_Store'), 'finder');
    expect(await shell({ picked: dotted }).call(CHANNELS.chooseMirrorFolder)).toEqual({ status: 'chosen', folder: dotted });

    const mirrored = temp('mirror');
    const bytes = text('# Agenda\n');
    writeFileSync(join(mirrored, 'Agenda.md'), bytes);
    writeFileSync(join(mirrored, MIRROR_MANIFEST_FILE), serializeMirrorManifest(manifest([entry('Agenda.md', bytes)])));
    expect(await shell({ picked: mirrored }).call(CHANNELS.chooseMirrorFolder)).toEqual({ status: 'chosen', folder: mirrored });
  });

  it.each([
    ['a file of its own', (folder: string) => writeFileSync(join(folder, 'Spec.md'), 'the person\'s own notes')],
    ['a subfolder', (folder: string) => mkdirSync(join(folder, 'Work'))],
    ['a manifest that does not parse', (folder: string) => writeFileSync(join(folder, MIRROR_MANIFEST_FILE), '{oops')],
  ])('refuses a folder holding %s and keeps the earlier setting', async (_what, fill) => {
    const earlier = temp('mirror');
    const first = shell({ picked: earlier });
    await first.call(CHANNELS.chooseMirrorFolder);
    const occupied = temp('occupied');
    fill(occupied);
    writeFileSync(join(occupied, 'Notes.md'), 'more of their own');
    const refused = first.restart(occupied);
    expect(await refused.call(CHANNELS.chooseMirrorFolder)).toEqual({ status: 'not-empty', folder: occupied });
    expect(await refused.call(CHANNELS.mirrorFolder)).toBe(earlier);
    expect(await refused.restart().call(CHANNELS.mirrorFolder)).toBe(earlier);

    const fresh = shell({ picked: occupied });
    expect(await fresh.call(CHANNELS.chooseMirrorFolder)).toEqual({ status: 'not-empty', folder: occupied });
    expect(await fresh.call(CHANNELS.mirrorFolder)).toBeNull();
    expect(existsSync(fresh.settingFile)).toBe(false);
  });
});

describe('applying a mirror batch', () => {
  async function chosen() {
    const folder = temp('mirror');
    const s = shell({ picked: folder });
    await s.call(CHANNELS.chooseMirrorFolder);
    return { folder, ...s };
  }

  it('writes pages and assets inside the folder, then a manifest the shell reads back', async () => {
    const { folder, call } = await chosen();
    const picture = new Uint8Array([137, 80, 78, 71, 1]);
    const asset = `${sha(picture)}.png`;
    const bytes = text('# Agenda\n\n![](../../assets/x.png)\n');
    const next = manifest([entry('Work/Projects/Agenda.md', bytes, [asset])]);
    const result = await call(
      CHANNELS.applyMirrorBatch,
      batch({ assets: [{ path: `assets/${asset}`, hash: sha(picture), bytes: picture }], pages: [{ path: 'Work/Projects/Agenda.md', bytes }], manifest: next }),
    );
    expect(result).toMatchObject({ written: 2, removed: 0, refused: [] });
    expect(filesUnder(folder)).toEqual([MIRROR_MANIFEST_FILE, 'Work/Projects/Agenda.md', `assets/${asset}`]);
    expect(readFileSync(join(folder, 'assets', asset))).toEqual(Buffer.from(picture));
    expect(parseMirrorManifest((await call(CHANNELS.readMirrorManifest)) as Uint8Array)).toEqual(next);
  });

  it('refuses traversal and absolute paths and writes nothing outside the folder', async () => {
    const { folder, call } = await chosen();
    const outside = join(folder, '..', 'escaped.md');
    const bytes = text('# Escape\n');
    const result = (await call(
      CHANNELS.applyMirrorBatch,
      batch({
        pages: [
          { path: '../escaped.md', bytes },
          { path: 'Work/../../escaped.md', bytes },
          { path: outside, bytes },
          { path: 'C:/escaped.md', bytes },
        ],
        manifest: manifest([]),
      }),
    )) as { written: number; refused: Array<{ path: string }> };
    expect(result.written).toBe(0);
    expect(result.refused.map((r) => r.path)).toEqual(['../escaped.md', 'Work/../../escaped.md', outside, 'C:/escaped.md']);
    expect(existsSync(outside)).toBe(false);
    expect(filesUnder(folder)).toEqual([MIRROR_MANIFEST_FILE]);
  });

  it('refuses a removal the manifest on disk does not list, and leaves stray files alone', async () => {
    const { folder, call } = await chosen();
    writeFileSync(join(folder, 'Stray.md'), 'kept');
    writeFileSync(join(folder, 'Other notes.txt'), 'kept too');
    const bytes = text('# Agenda\n');
    await call(CHANNELS.applyMirrorBatch, batch({ pages: [{ path: 'Agenda.md', bytes }], manifest: manifest([entry('Agenda.md', bytes)]) }));
    const result = (await call(
      CHANNELS.applyMirrorBatch,
      batch({ removals: ['Stray.md', 'Agenda.md'], manifest: manifest([]) }),
    )) as { removed: number; refused: Array<{ path: string; reason: string }> };
    expect(result.removed).toBe(1);
    expect(result.refused).toEqual([{ path: 'Stray.md', reason: 'the mirror manifest on disk does not list it' }]);
    expect(filesUnder(folder)).toEqual([MIRROR_MANIFEST_FILE, 'Other notes.txt', 'Stray.md']);
  });

  it('rejects with no folder chosen', async () => {
    const { call } = shell();
    await expect(call(CHANNELS.applyMirrorBatch, batch({ manifest: manifest([]) }))).rejects.toThrow('No mirror folder is chosen');
    await expect(call(CHANNELS.readMirrorManifest)).rejects.toThrow('No mirror folder is chosen');
  });

  it('rejects naming the folder when it is gone, and keeps the setting', async () => {
    const { folder, call, restart } = await chosen();
    await rm(folder, { recursive: true });
    await expect(call(CHANNELS.applyMirrorBatch, batch({ manifest: manifest([]) }))).rejects.toThrow(`${folder} does not exist`);
    await expect(call(CHANNELS.readMirrorManifest)).rejects.toThrow(`${folder} does not exist`);
    expect(existsSync(folder)).toBe(false);
    expect(await call(CHANNELS.mirrorFolder)).toBe(folder);
    expect(await restart().call(CHANNELS.mirrorFolder)).toBe(folder);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('rejects naming the folder when it cannot be written', async () => {
    const { folder, call } = await chosen();
    chmodSync(folder, 0o500);
    try {
      const bytes = text('# Agenda\n');
      await expect(
        call(CHANNELS.applyMirrorBatch, batch({ pages: [{ path: 'Agenda.md', bytes }], manifest: manifest([entry('Agenda.md', bytes)]) })),
      ).rejects.toThrow(folder);
      expect(await call(CHANNELS.mirrorFolder)).toBe(folder);
    } finally {
      chmodSync(folder, 0o700);
    }
  });
});
