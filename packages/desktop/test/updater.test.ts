import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { bundleOf, isNewer, parseManifest, SWAP_SCRIPT, Updater, whyNoUpdates, type UpdaterDeps } from '../src/updater.js';

const BUNDLE_ID = 'org.example.notes';
const RELEASE = 'https://updates.example/latest';
const ZIP = new TextEncoder().encode('zip bytes');

function manifestFor(version: string, bytes: Uint8Array = ZIP, changes: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version,
    file: 'Notes-arm64-mac.zip',
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length,
    ...changes,
  });
}

/** An updater whose release answers with `manifest` and `zip`, and whose unzip writes an app with the given identity. */
function setup(options: { manifest: string; zip?: Uint8Array; unpackedId?: string; unpackedVersion?: string; codesignFails?: boolean }) {
  const dir = mkdtempSync(join(tmpdir(), 'looseleaf-updater-'));
  const release = { manifest: options.manifest, zip: options.zip ?? ZIP };
  const ready: string[] = [];
  const logs: string[] = [];
  const spawned: Array<{ command: string; args: string[] }> = [];
  const fetched: string[] = [];
  const deps: UpdaterDeps = {
    currentVersion: '0.1.5',
    bundleId: BUNDLE_ID,
    bundle: '/Applications/Notes.app',
    updatesDir: join(dir, 'updates'),
    releaseUrl: RELEASE,
    pid: 4242,
    fetch: async (url) => {
      fetched.push(url);
      if (url === `${RELEASE}/latest.json`) return new Response(release.manifest);
      if (url === `${RELEASE}/Notes-arm64-mac.zip`) return new Response(release.zip as unknown as BodyInit);
      return new Response('missing', { status: 404 });
    },
    run: async (command, args) => {
      if (command === '/usr/bin/ditto') {
        mkdirSync(join(args[3]!, 'Notes.app', 'Contents'), { recursive: true });
        return '';
      }
      if (command === '/usr/bin/plutil') {
        return args[1] === 'CFBundleIdentifier' ? `${options.unpackedId ?? BUNDLE_ID}\n` : `${options.unpackedVersion ?? '0.1.9'}\n`;
      }
      if (command === '/usr/bin/codesign' && options.codesignFails) throw new Error('codesign: invalid signature');
      return '';
    },
    spawnDetached: (command, args) => spawned.push({ command, args }),
    onReady: (version) => ready.push(version),
    log: (message) => logs.push(message),
  };
  return { updater: new Updater(deps), deps, release, ready, logs, spawned, fetched };
}

describe('parseManifest', () => {
  it('reads a manifest', () => {
    expect(parseManifest(manifestFor('0.1.9'))).toEqual({
      version: '0.1.9',
      file: 'Notes-arm64-mac.zip',
      sha256: createHash('sha256').update(ZIP).digest('hex'),
      size: ZIP.length,
    });
  });

  it.each([
    ['text that is not JSON', 'Not Found'],
    ['a version with a suffix', manifestFor('0.1.9-beta')],
    ['a file with a folder', manifestFor('0.1.9', ZIP, { file: '../Notes.zip' })],
    ['a file at another address', manifestFor('0.1.9', ZIP, { file: 'https://elsewhere.example/Notes.zip' })],
    ['a short hash', manifestFor('0.1.9', ZIP, { sha256: 'abc' })],
    ['a size of zero', manifestFor('0.1.9', ZIP, { size: 0 })],
    ['a size past the limit', manifestFor('0.1.9', ZIP, { size: 2 * 1024 * 1024 * 1024 })],
  ])('refuses %s', (_what, text) => {
    expect(parseManifest(text)).toBeNull();
  });
});

describe('isNewer', () => {
  it('compares each part as a number', () => {
    expect(isNewer('0.1.10', '0.1.9')).toBe(true);
    expect(isNewer('0.2.0', '0.1.99')).toBe(true);
    expect(isNewer('1.0.0', '0.9.9')).toBe(true);
    expect(isNewer('0.1.9', '0.1.9')).toBe(false);
    expect(isNewer('0.1.8', '0.1.9')).toBe(false);
  });

  it('never calls a version it cannot read newer', () => {
    expect(isNewer('0.1', '0.1.9')).toBe(false);
    expect(isNewer('0.1.x', '0.1.9')).toBe(false);
  });
});

describe('bundleOf', () => {
  it('finds the .app folder around an executable', () => {
    expect(bundleOf('/Applications/Notes.app/Contents/MacOS/Notes')).toBe('/Applications/Notes.app');
    expect(bundleOf('/Users/ann/My Apps/Notes 2.app/Contents/MacOS/Notes')).toBe('/Users/ann/My Apps/Notes 2.app');
  });

  it('is null outside one', () => {
    expect(bundleOf('/usr/local/bin/notes')).toBeNull();
  });
});

describe('whyNoUpdates', () => {
  const bundle = mkdtempSync(join(tmpdir(), 'looseleaf-bundle-'));
  const mac = { packaged: true, platform: 'darwin', arch: 'arm64', bundle };

  it('allows a packaged Apple silicon Mac app in a writable folder', async () => {
    expect(await whyNoUpdates(mac)).toBeNull();
  });

  it.each([
    ['an unpackaged run', { ...mac, packaged: false }],
    ['Windows', { ...mac, platform: 'win32' }],
    ['an Intel Mac', { ...mac, arch: 'x64' }],
    ['no .app folder', { ...mac, bundle: null }],
    ['a translocated app', { ...mac, bundle: '/private/var/folders/x/AppTranslocation/1234/d/Notes.app' }],
    ['a folder that is not there to write to', { ...mac, bundle: join(bundle, 'missing', 'Notes.app') }],
  ])('refuses %s with a reason', async (_what, install) => {
    expect(await whyNoUpdates(install)).toEqual(expect.any(String));
  });
});

describe('Updater', () => {
  it('stages a newer build, says it is ready, and swaps it in as the app quits', async () => {
    const { updater, deps, ready, spawned } = setup({ manifest: manifestFor('0.1.9') });
    await updater.check();
    expect(ready).toEqual(['0.1.9']);
    expect(updater.readyVersion).toBe('0.1.9');
    const staged = join(deps.updatesDir, '0.1.9', 'app', 'Notes.app');
    expect(existsSync(staged)).toBe(true);
    // The zip is gone once it is unpacked.
    expect(existsSync(join(deps.updatesDir, '0.1.9', 'Notes-arm64-mac.zip'))).toBe(false);

    updater.applyOnQuit();
    updater.applyOnQuit();
    expect(spawned).toEqual([
      { command: '/bin/sh', args: ['-c', SWAP_SCRIPT, 'sh', '4242', '/Applications/Notes.app', staged, join(deps.updatesDir, 'replaced.app'), '0'] },
    ]);
  });

  it('reopens the app after the swap when a restart was asked for', async () => {
    const { updater, spawned } = setup({ manifest: manifestFor('0.1.9') });
    await updater.check();
    updater.reopen = true;
    updater.applyOnQuit();
    expect(spawned[0]!.args.at(-1)).toBe('1');
  });

  it('does nothing for the same or an older version', async () => {
    for (const version of ['0.1.5', '0.1.4']) {
      const { updater, ready, fetched, spawned } = setup({ manifest: manifestFor(version) });
      await updater.check();
      updater.applyOnQuit();
      expect(ready).toEqual([]);
      expect(fetched).toEqual([`${RELEASE}/latest.json`]);
      expect(spawned).toEqual([]);
    }
  });

  it('downloads a version once, and replaces it when a later one appears', async () => {
    const { updater, deps, release, ready, fetched } = setup({ manifest: manifestFor('0.1.9') });
    await updater.check();
    await updater.check();
    expect(fetched.filter((url) => url.endsWith('.zip'))).toHaveLength(1);

    release.manifest = manifestFor('0.1.9', ZIP, { version: '0.1.12' });
    // The fake unzip reports 0.1.9, so the later build is refused and the earlier one stays ready.
    await updater.check();
    expect(ready).toEqual(['0.1.9']);
    expect(updater.readyVersion).toBe('0.1.9');
    expect(existsSync(join(deps.updatesDir, '0.1.9', 'app', 'Notes.app'))).toBe(true);
  });

  it.each([
    ['a zip whose hash differs from the manifest', { manifest: manifestFor('0.1.9', new TextEncoder().encode('zip bytez')) }, 'sha256'],
    ['a zip longer than the manifest says', { manifest: manifestFor('0.1.9', ZIP, { size: 4 }) }, 'longer'],
    ['a zip shorter than the manifest says', { manifest: manifestFor('0.1.9', ZIP, { size: 400 }) }, 'bytes'],
    ['an app with another identifier', { manifest: manifestFor('0.1.9'), unpackedId: 'org.example.other' }, 'identifier'],
    ['an app whose version differs from the manifest', { manifest: manifestFor('0.1.9'), unpackedVersion: '0.1.8' }, 'version'],
    ['an app whose signature does not verify', { manifest: manifestFor('0.1.9'), codesignFails: true }, 'codesign'],
    ['a manifest it cannot read', { manifest: '<html>Not Found</html>' }, 'latest.json'],
  ])('leaves the running app alone for %s', async (_what, options, logged) => {
    const { updater, ready, logs, spawned } = setup(options);
    await updater.check();
    updater.applyOnQuit();
    expect(ready).toEqual([]);
    expect(updater.readyVersion).toBeNull();
    expect(spawned).toEqual([]);
    expect(logs.join('\n')).toContain(logged);
  });

  it('logs and carries on when the release cannot be reached', async () => {
    const { updater, deps, logs } = setup({ manifest: manifestFor('0.1.9') });
    const offline = new Updater({ ...deps, fetch: vi.fn(async () => Promise.reject(new Error('net::ERR_INTERNET_DISCONNECTED'))) });
    await expect(offline.check()).resolves.toBeUndefined();
    expect(logs.join('\n')).toContain('ERR_INTERNET_DISCONNECTED');
    expect(updater.readyVersion).toBeNull();
  });

  it('removes what an earlier run left in its folder', async () => {
    const { updater, deps } = setup({ manifest: manifestFor('0.1.5') });
    mkdirSync(join(deps.updatesDir, '0.1.3', 'app'), { recursive: true });
    await updater.check();
    expect(existsSync(join(deps.updatesDir, '0.1.3'))).toBe(false);
  });
});

describe.skipIf(process.platform === 'win32')('the swap script', () => {
  function folders() {
    const dir = mkdtempSync(join(tmpdir(), 'looseleaf-swap-'));
    const bundle = join(dir, 'Applications', 'Notes.app');
    const staged = join(dir, 'updates', '0.1.9', 'app', 'Notes.app');
    const old = join(dir, 'updates', 'replaced.app');
    mkdirSync(bundle, { recursive: true });
    writeFileSync(join(bundle, 'version'), 'old');
    return { bundle, staged, old };
  }

  /** Runs the script against a process that has already exited, without reopening anything. */
  async function swap(bundle: string, staged: string, old: string): Promise<void> {
    const exited = spawn(process.execPath, ['-e', '']);
    await new Promise((done) => exited.on('exit', done));
    await new Promise<void>((done) => {
      execFile('/bin/sh', ['-c', SWAP_SCRIPT, 'sh', String(exited.pid), bundle, staged, old, '0'], () => done());
    });
  }

  it('puts the staged app where the old one was and removes the old one', async () => {
    const { bundle, staged, old } = folders();
    mkdirSync(staged, { recursive: true });
    writeFileSync(join(staged, 'version'), 'new');
    await swap(bundle, staged, old);
    expect(readFileSync(join(bundle, 'version'), 'utf8')).toBe('new');
    expect(existsSync(staged)).toBe(false);
    expect(existsSync(old)).toBe(false);
  });

  it('puts the old app back when the staged one cannot be moved in', async () => {
    const { bundle, staged, old } = folders();
    mkdirSync(join(staged, '..'), { recursive: true });
    await swap(bundle, staged, old);
    expect(readFileSync(join(bundle, 'version'), 'utf8')).toBe('old');
    expect(existsSync(old)).toBe(false);
  });
});
