/**
 * Proves the OneNote handlers cannot change the folders they read. Every write
 * function in `node:fs/promises` is replaced with one that records the call and
 * throws, `open` must be called with 'r', and the file handles it returns have
 * their write methods replaced the same way.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CHANNELS } from '../src/channels.js';
import { createHandlers, type ShellHost } from '../src/ipc.js';
import { oneNoteFixture, snapshotFiles } from './onenote-fixtures.js';

const { fsCalls, WRITE_FUNCTIONS, HANDLE_WRITE_METHODS } = vi.hoisted(() => ({
  fsCalls: { writes: [] as string[], openFlags: [] as unknown[] },
  WRITE_FUNCTIONS: [
    'appendFile', 'chmod', 'chown', 'copyFile', 'cp', 'lchmod', 'lchown', 'link', 'lutimes', 'mkdir',
    'mkdtemp', 'rename', 'rm', 'rmdir', 'symlink', 'truncate', 'unlink', 'utimes', 'writeFile',
  ],
  HANDLE_WRITE_METHODS: ['appendFile', 'chmod', 'chown', 'datasync', 'sync', 'truncate', 'utimes', 'write', 'writeFile', 'writev'],
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  const forbid = (name: string) => () => {
    fsCalls.writes.push(name);
    throw new Error(`${name} must not be called by the OneNote handlers`);
  };
  const mocked: Record<string, unknown> = { ...real };
  for (const name of WRITE_FUNCTIONS) mocked[name] = forbid(name);
  mocked.open = async (path: string, flags?: unknown, mode?: number) => {
    fsCalls.openFlags.push(flags);
    const handle = await real.open(path, flags as string, mode);
    for (const method of HANDLE_WRITE_METHODS) {
      (handle as unknown as Record<string, unknown>)[method] = forbid(`FileHandle.${method}`);
    }
    return handle;
  };
  return { ...mocked, default: mocked };
});

afterEach(() => {
  fsCalls.writes.length = 0;
  fsCalls.openFlags.length = 0;
});

describe('OneNote handlers are read-only', () => {
  it('list and read without calling any write API, opening files with "r" only', async () => {
    const { folder } = oneNoteFixture();
    const writeFile = vi.fn(async () => undefined);
    const handlers = createHandlers({
      platform: 'darwin',
      homeDir: '/nowhere',
      env: {},
      saveFolder: '/nowhere',
      writeFile,
      mirrorSettingFile: '/nowhere/mirror-folder.json',
      update: { readyVersion: () => null, restart: () => undefined },
    });
    const host: ShellHost = {
      showSaveDialog: vi.fn(async () => '/nowhere/out'),
      showFolderDialog: async () => folder,
      printToPdf: vi.fn(async () => new Uint8Array()),
    };
    const before = snapshotFiles([join(folder, 'Work', 'Meetings (On 14-11-2026).one'), join(folder, 'Personal', 'Recipes.one')]);

    await handlers[CHANNELS.pickFolder](host, []);
    const files = (await handlers[CHANNELS.listOneNoteFiles](host, [folder])) as Array<{ path: string }>;
    expect(files.length).toBe(4);
    for (const file of files) await handlers[CHANNELS.readOneNoteFile](host, [folder, file.path]);
    await expect(handlers[CHANNELS.readOneNoteFile](host, [folder, '../Elsewhere/Private.one'])).rejects.toThrow();

    expect(fsCalls.writes).toEqual([]);
    expect(fsCalls.openFlags).toEqual(files.map(() => 'r'));
    expect(writeFile).not.toHaveBeenCalled();
    expect(host.showSaveDialog).not.toHaveBeenCalled();
    expect(host.printToPdf).not.toHaveBeenCalled();
    expect(snapshotFiles(before.map((f) => f.path))).toEqual(before);
  });

  it('import no write function from node:fs in the modules behind them', () => {
    const readOnly = new Set(['access', 'constants', 'lstat', 'open', 'readdir', 'realpath', 'stat']);
    for (const file of ['onenote-files.ts', 'ipc.ts']) {
      const source = readFileSync(fileURLToPath(new URL(`../src/${file}`, import.meta.url)), 'utf8');
      const fsImports = [...source.matchAll(/import\s*\{([^}]*)\}\s*from\s*'(?:node:)?fs(?:\/promises)?'/g)];
      const anyFsImport = source.match(/from\s*'(?:node:)?fs(?:\/promises)?'|require\(\s*'(?:node:)?fs/g) ?? [];
      expect(anyFsImport.length, `${file} reaches fs only through named imports`).toBe(fsImports.length);
      for (const match of fsImports) {
        for (const name of (match[1] ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
          expect(readOnly.has(name), `${file} imports ${name} from fs`).toBe(true);
        }
      }
      for (const call of source.matchAll(/\bopen\(([^)]*)\)/g)) {
        expect(call[1], `${file}: ${call[0]}`).toMatch(/,\s*'r'\s*$/);
      }
    }
  });
});
