import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  findOneNoteBackups,
  isOneNoteFileName,
  listOneNoteFiles,
  oneNoteBackupCandidate,
  readOneNoteFile,
} from '../src/onenote-files.js';
import { oneNoteFixture, snapshotFiles } from './onenote-fixtures.js';

const MAC_BACKUP =
  'Library/Containers/com.microsoft.onenote.mac/Data/Library/Application Support/Microsoft User Data/OneNote/15.0/Backup';

describe('OneNote backup folder', () => {
  it('is under the OneNote container on macOS and LOCALAPPDATA on Windows', () => {
    expect(oneNoteBackupCandidate('darwin', '/Users/ann', {})).toBe(`/Users/ann/${MAC_BACKUP}`);
    expect(oneNoteBackupCandidate('win32', 'C:\\Users\\ann', { LOCALAPPDATA: 'C:\\Users\\ann\\AppData\\Local' })).toBe(
      'C:\\Users\\ann\\AppData\\Local\\Microsoft\\OneNote\\16.0\\Backup',
    );
    expect(oneNoteBackupCandidate('win32', 'C:\\Users\\ann', {})).toBeNull();
    expect(oneNoteBackupCandidate('linux', '/home/ann', {})).toBeNull();
  });

  it('is found only when it exists as a readable folder', async () => {
    const home = await mkdtemp(join(tmpdir(), 'looseleaf-home-'));
    expect(await findOneNoteBackups('darwin', home, {})).toBeNull();
    await mkdir(join(home, MAC_BACKUP), { recursive: true });
    expect(await findOneNoteBackups('darwin', home, {})).toBe(join(home, MAC_BACKUP));
    expect(await findOneNoteBackups('linux', home, {})).toBeNull();

    const fileHome = await mkdtemp(join(tmpdir(), 'looseleaf-home-'));
    await mkdir(join(fileHome, MAC_BACKUP, '..'), { recursive: true });
    await writeFile(join(fileHome, MAC_BACKUP), 'not a folder');
    expect(await findOneNoteBackups('darwin', fileHome, {})).toBeNull();
  });
});

describe('listOneNoteFiles', () => {
  it('lists only .one and .onetoc2 files, with sorted relative POSIX paths and sizes', async () => {
    const { folder } = oneNoteFixture();
    expect(await listOneNoteFiles(folder)).toEqual([
      { path: 'Personal/Recipes.one', size: 2 },
      { path: 'Work/Archive/Old.ONE', size: 1 },
      { path: 'Work/Meetings (On 14-11-2026).one', size: 4 },
      { path: 'Work/Open Notebook.onetoc2', size: 3 },
    ]);
  });

  it('skips symbolic links to files and to folders', async () => {
    const { folder } = oneNoteFixture();
    const paths = (await listOneNoteFiles(folder)).map((f) => f.path);
    expect(paths).not.toContain('Personal/Linked.one');
    expect(paths.some((p) => p.startsWith('Linked folder'))).toBe(false);
  });

  it('leaves out a subfolder it cannot read', async () => {
    const { folder } = oneNoteFixture();
    await chmod(join(folder, 'Personal'), 0o000);
    try {
      expect((await listOneNoteFiles(folder)).map((f) => f.path)).not.toContain('Personal/Recipes.one');
    } finally {
      await chmod(join(folder, 'Personal'), 0o755);
    }
  });

  it('fails with the path when the folder itself is missing', async () => {
    await expect(listOneNoteFiles('/no/such/looseleaf/folder')).rejects.toThrow(/no\/such\/looseleaf\/folder/);
  });
});

describe('readOneNoteFile', () => {
  it('reads a listed file', async () => {
    const { folder } = oneNoteFixture();
    expect([...(await readOneNoteFile(folder, 'Work/Meetings (On 14-11-2026).one'))]).toEqual([4, 5, 6, 7]);
  });

  it('refuses paths that escape the folder', async () => {
    const { folder, outside } = oneNoteFixture();
    const attempts = [
      '../Elsewhere/Private.one',
      'Work/../../Elsewhere/Private.one',
      'Work/../Personal/Recipes.one',
      '..\\Elsewhere\\Private.one',
      join(outside, 'Private.one'),
      '/etc/hosts.one',
      'C:\\Windows\\x.one',
      'C:x.one',
      './Personal/Recipes.one',
      'Personal//Recipes.one',
      'Personal/Recipes.one\0',
      '',
    ];
    for (const attempt of attempts) {
      await expect(readOneNoteFile(folder, attempt), JSON.stringify(attempt)).rejects.toThrow(/Refusing to read/);
    }
  });

  it('refuses symbolic links, to a file or through a folder', async () => {
    const { folder } = oneNoteFixture();
    await expect(readOneNoteFile(folder, 'Personal/Linked.one')).rejects.toThrow(/resolves to/);
    await expect(readOneNoteFile(folder, 'Linked folder/Private.one')).rejects.toThrow(/resolves to/);
  });

  it('refuses files that are not OneNote files', async () => {
    const { folder } = oneNoteFixture();
    await expect(readOneNoteFile(folder, 'Personal/notes.txt')).rejects.toThrow(/only .one and .onetoc2/);
    await expect(readOneNoteFile(folder, 'Personal/Recipes.one.bak')).rejects.toThrow(/only .one and .onetoc2/);
  });

  it('leaves every file byte-identical with unchanged mtime and ctime after listing and reading', async () => {
    const { folder, outside } = oneNoteFixture();
    const files = [
      join(folder, 'Work', 'Open Notebook.onetoc2'),
      join(folder, 'Work', 'Meetings (On 14-11-2026).one'),
      join(folder, 'Work', 'Archive', 'Old.ONE'),
      join(folder, 'Personal', 'Recipes.one'),
      join(outside, 'Private.one'),
    ];
    const before = snapshotFiles(files);
    for (const file of await listOneNoteFiles(folder)) await readOneNoteFile(folder, file.path);
    await readOneNoteFile(folder, 'Personal/Linked.one').catch(() => undefined);
    expect(snapshotFiles(files)).toEqual(before);
  });
});

describe('isOneNoteFileName', () => {
  it('matches the two extensions in any case', () => {
    expect(isOneNoteFileName('a.one')).toBe(true);
    expect(isOneNoteFileName('A.OneToc2')).toBe(true);
    expect(isOneNoteFileName('a.onepkg')).toBe(false);
    expect(isOneNoteFileName('one')).toBe(false);
  });
});
