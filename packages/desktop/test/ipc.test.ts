import { mkdtempSync } from 'node:fs';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CHANNELS } from '../src/channels.js';
import { createHandlers, expectAbsolutePath, expectBytes, expectString, type ShellHost } from '../src/ipc.js';
import { oneNoteFixture } from './onenote-fixtures.js';

const SAVE_FOLDER = join('/', 'Users', 'ann', 'Downloads');

function setup(options: { home?: string; savePath?: string | null; folder?: string | null } = {}) {
  const writeFile = vi.fn(async (_path: string, _bytes: Uint8Array) => undefined);
  const handlers = createHandlers({
    platform: 'darwin',
    homeDir: options.home ?? '/nowhere',
    env: {},
    saveFolder: SAVE_FOLDER,
    writeFile,
    mirrorSettingFile: join(mkdtempSync(join(tmpdir(), 'looseleaf-user-data-')), 'mirror-folder.json'),
  });
  const host = {
    showSaveDialog: vi.fn(async (_defaultPath: string, _filters: Array<{ name: string; extensions: string[] }>) =>
      options.savePath === undefined ? '/Users/ann/Desktop/out' : options.savePath,
    ),
    showFolderDialog: vi.fn(async () => options.folder ?? null),
    printToPdf: vi.fn(async () => new Uint8Array([37, 80, 68, 70])),
  } satisfies ShellHost;
  return { handlers, host, writeFile };
}

describe('argument validators', () => {
  it('accept the right types', () => {
    expect(expectString('x', 'name', 10)).toBe('x');
    expect(expectBytes(new Uint8Array([1]), 'bytes')).toEqual(new Uint8Array([1]));
    expect(expectBytes(Buffer.from([1]), 'bytes')).toBeInstanceOf(Uint8Array);
    expect(expectAbsolutePath('/Users/ann', 'folder')).toBe('/Users/ann');
  });

  it('reject anything else with a message naming the argument', () => {
    for (const bad of [undefined, null, 3, {}, [], new Uint8Array()]) {
      expect(() => expectString(bad, 'name', 10)).toThrow(/^name must be a string/);
    }
    expect(() => expectString('', 'name', 10)).toThrow(/1 to 10 characters/);
    expect(() => expectString('x'.repeat(11), 'name', 10)).toThrow(/1 to 10 characters, got 11/);
    for (const bad of ['bytes', [1, 2], { 0: 1, length: 1 }, new ArrayBuffer(2), null]) {
      expect(() => expectBytes(bad, 'bytes')).toThrow(/^bytes must be a Uint8Array/);
    }
    expect(() => expectAbsolutePath('relative/path', 'folder')).toThrow(/absolute path/);
    expect(() => expectAbsolutePath('/a\0b', 'folder')).toThrow(/absolute path/);
  });
});

describe('every handler checks its arguments', () => {
  const badCalls: Array<[string, unknown[]]> = [
    [CHANNELS.saveFile, ['name.html']],
    [CHANNELS.saveFile, [42, new Uint8Array()]],
    [CHANNELS.saveFile, ['name.html', 'not bytes']],
    [CHANNELS.savePdf, []],
    [CHANNELS.savePdf, [{ name: 'x' }]],
    [CHANNELS.findOneNoteBackups, ['extra']],
    [CHANNELS.pickFolder, ['extra']],
    [CHANNELS.listOneNoteFiles, []],
    [CHANNELS.listOneNoteFiles, [7]],
    [CHANNELS.listOneNoteFiles, ['relative']],
    [CHANNELS.readOneNoteFile, ['/a']],
    [CHANNELS.readOneNoteFile, ['/a', 3]],
    [CHANNELS.readOneNoteFile, [null, 'x.one']],
    [CHANNELS.chooseMirrorFolder, ['/elsewhere']],
    [CHANNELS.mirrorFolder, ['extra']],
    [CHANNELS.stopMirroring, ['extra']],
    [CHANNELS.readMirrorManifest, ['/elsewhere']],
    [CHANNELS.applyMirrorBatch, []],
    [CHANNELS.applyMirrorBatch, ['/elsewhere', { removals: [], assets: [], pages: [], manifest: new Uint8Array() }]],
    [CHANNELS.applyMirrorBatch, [{ removals: [], assets: [], pages: [] }]],
    [CHANNELS.applyMirrorBatch, [{ removals: [3], assets: [], pages: [], manifest: new Uint8Array() }]],
    [CHANNELS.applyMirrorBatch, [{ removals: [], assets: [{ path: 'assets/a.png', hash: 'x' }], pages: [], manifest: new Uint8Array() }]],
    [CHANNELS.applyMirrorBatch, [{ removals: [], assets: [], pages: [{ path: 'a.md', bytes: 'text' }], manifest: new Uint8Array() }]],
    [CHANNELS.applyMirrorBatch, [{ removals: [], assets: [], pages: [], manifest: new TextEncoder().encode('{}') }]],
  ];
  it.each(badCalls)('%s rejects %j', async (channel, args) => {
    const { handlers, host, writeFile } = setup();
    await expect(handlers[channel as keyof typeof handlers](host, args)).rejects.toThrow(TypeError);
    expect(host.showSaveDialog).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
  });
});

describe('saveFile and savePdf', () => {
  it('saveFile offers the bare file name in the save folder and writes the bytes', async () => {
    const { handlers, host, writeFile } = setup();
    const bytes = new Uint8Array([1, 2, 3]);
    expect(await handlers[CHANNELS.saveFile](host, ['../../etc/Notes.html', bytes])).toBe(true);
    expect(host.showSaveDialog).toHaveBeenCalledWith(join(SAVE_FOLDER, 'Notes.html'), [
      { name: 'HTML', extensions: ['html'] },
    ]);
    expect(writeFile).toHaveBeenCalledWith('/Users/ann/Desktop/out', bytes);
  });

  it('saveFile resolves false and writes nothing when cancelled', async () => {
    const { handlers, host, writeFile } = setup({ savePath: null });
    expect(await handlers[CHANNELS.saveFile](host, ['Notes.md', new Uint8Array()])).toBe(false);
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('savePdf adds .pdf, prints after the dialog and writes the PDF', async () => {
    const { handlers, host, writeFile } = setup();
    expect(await handlers[CHANNELS.savePdf](host, ['C:\\Users\\x\\Meeting'])).toBe(true);
    expect(host.showSaveDialog).toHaveBeenCalledWith(join(SAVE_FOLDER, 'Meeting.pdf'), [{ name: 'PDF', extensions: ['pdf'] }]);
    expect(writeFile).toHaveBeenCalledWith('/Users/ann/Desktop/out', new Uint8Array([37, 80, 68, 70]));
  });

  it('savePdf does not print when cancelled', async () => {
    const { handlers, host, writeFile } = setup({ savePath: null });
    expect(await handlers[CHANNELS.savePdf](host, ['Meeting.pdf'])).toBe(false);
    expect(host.printToPdf).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
  });
});

describe('OneNote folder grants', () => {
  it('refuses to list or read a folder that was never chosen', async () => {
    const { folder } = oneNoteFixture();
    const { handlers, host } = setup();
    await expect(handlers[CHANNELS.listOneNoteFiles](host, [folder])).rejects.toThrow(/is not inside a folder chosen/);
    await expect(handlers[CHANNELS.readOneNoteFile](host, [folder, 'Personal/Recipes.one'])).rejects.toThrow(
      /is not inside a folder chosen/,
    );
  });

  it('allows the picked folder and folders inside it, not its parent or a symlink out of it', async () => {
    const { root, folder } = oneNoteFixture();
    const { handlers, host } = setup({ folder });
    expect(await handlers[CHANNELS.pickFolder](host, [])).toBe(folder);
    expect(await handlers[CHANNELS.listOneNoteFiles](host, [folder])).toHaveLength(4);
    expect(await handlers[CHANNELS.listOneNoteFiles](host, [join(folder, 'Work')])).toHaveLength(3);
    expect([...((await handlers[CHANNELS.readOneNoteFile](host, [folder, 'Personal/Recipes.one'])) as Uint8Array)]).toEqual([9, 10]);
    await expect(handlers[CHANNELS.listOneNoteFiles](host, [root])).rejects.toThrow(/is not inside/);
    await expect(handlers[CHANNELS.listOneNoteFiles](host, [join(folder, 'Linked folder')])).rejects.toThrow(/is not inside/);
    await expect(handlers[CHANNELS.listOneNoteFiles](host, [`${folder}-sibling`])).rejects.toThrow();
  });

  it('grants nothing when the picker is cancelled', async () => {
    const { folder } = oneNoteFixture();
    const { handlers, host } = setup({ folder: null });
    expect(await handlers[CHANNELS.pickFolder](host, [])).toBeNull();
    await expect(handlers[CHANNELS.listOneNoteFiles](host, [folder])).rejects.toThrow(/is not inside/);
  });

  it('allows the OneNote backup folder once it has been found', async () => {
    const home = await mkdtemp(join(tmpdir(), 'looseleaf-home-'));
    const backup = join(
      home,
      'Library/Containers/com.microsoft.onenote.mac/Data/Library/Application Support/Microsoft User Data/OneNote/15.0/Backup',
    );
    await mkdir(join(backup, 'Work'), { recursive: true });
    const { handlers, host } = setup({ home });
    await expect(handlers[CHANNELS.listOneNoteFiles](host, [backup])).rejects.toThrow(/is not inside/);
    expect(await handlers[CHANNELS.findOneNoteBackups](host, [])).toBe(backup);
    expect(await handlers[CHANNELS.listOneNoteFiles](host, [backup])).toEqual([]);
  });
});
