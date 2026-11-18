/**
 * In-app updates for the Mac build. CI publishes each build as a zip plus a
 * manifest, `latest.json`, on one release. The updater reads the manifest,
 * downloads a newer zip into user data, checks it, and unpacks it next to the
 * running app's data as a staged app. The staged app takes the running one's
 * place after this process exits, by a detached shell script.
 *
 * The build has no Apple Developer ID, so there is no publisher signature to
 * check: trust is the release's HTTPS address plus the manifest's sha256.
 * Electron arrives through `UpdaterDeps`, so this runs in Node tests.
 */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, open, readdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** What `latest.json` says about the newest build. */
export interface UpdateManifest {
  /** Three numbers with dots, such as `0.1.57`. */
  version: string;
  /** The zip's name on the release. */
  file: string;
  /** The zip's sha256, lowercase hex. */
  sha256: string;
  /** The zip's length in bytes. */
  size: number;
}

/** No build comes near this; a manifest that claims more is refused before any download. */
const MAX_ZIP_BYTES = 1024 * 1024 * 1024;

/** The manifest in `text`, or null when it is not one this version reads. */
export function parseManifest(text: string): UpdateManifest | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const { version, file, sha256, size } = value as Record<string, unknown>;
  if (typeof version !== 'string' || !/^\d{1,9}\.\d{1,9}\.\d{1,9}$/.test(version)) return null;
  // A bare file name: the zip is only ever fetched from beside the manifest.
  if (typeof file !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,200}\.zip$/.test(file)) return null;
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) return null;
  if (typeof size !== 'number' || !Number.isInteger(size) || size <= 0 || size > MAX_ZIP_BYTES) return null;
  return { version, file, sha256, size };
}

/** Whether version `candidate` is later than `current`. Both are three numbers with dots; anything else is not newer. */
export function isNewer(candidate: string, current: string): boolean {
  const a = candidate.split('.').map(Number);
  const b = current.split('.').map(Number);
  if (a.length !== 3 || b.length !== 3 || [...a, ...b].some((n) => !Number.isInteger(n))) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i]! > b[i]!;
  }
  return false;
}

/** The `.app` folder that holds a running Mac executable, or null when the path is not inside one. */
export function bundleOf(exePath: string): string | null {
  const match = /^(\/.*\.app)\/Contents\/MacOS\/[^/]+$/.exec(exePath);
  return match ? match[1]! : null;
}

/**
 * Why this install cannot update itself, as a sentence for the log, or null
 * when it can. Updates are for the packaged Apple silicon Mac app, in a
 * folder this user can write to.
 */
export async function whyNoUpdates(install: {
  packaged: boolean;
  platform: string;
  arch: string;
  bundle: string | null;
}): Promise<string | null> {
  if (!install.packaged) return 'this is not a packaged build';
  if (install.platform !== 'darwin' || install.arch !== 'arm64') return `there are no published builds for ${install.platform} ${install.arch}`;
  const { bundle } = install;
  if (bundle === null) return 'the app is not running from an .app folder';
  // macOS runs a quarantined app from a read-only copy under this folder until the app is moved in Finder.
  if (bundle.includes('/AppTranslocation/')) return 'macOS is running the app from a read-only copy; move it to Applications in Finder first';
  try {
    await access(bundle, constants.W_OK);
    await access(dirname(bundle), constants.W_OK);
  } catch {
    return `${bundle} or its folder is not writable by this user`;
  }
  return null;
}

export interface UpdaterDeps {
  /** The running app's version. */
  currentVersion: string;
  /** The running app's bundle identifier; a download with another is refused. */
  bundleId: string;
  /** The running `.app` folder, which a staged app replaces. */
  bundle: string;
  /** A folder in user data that the updater owns; everything in it is removed at the first check. */
  updatesDir: string;
  /** Where `latest.json` and the zip are, without a trailing slash. */
  releaseUrl: string;
  /** This process, which the swap waits on. */
  pid: number;
  fetch(url: string): Promise<Response>;
  /** Runs a program to its end and resolves to its standard output; rejects on a non-zero exit. */
  run(command: string, args: string[]): Promise<string>;
  /** Starts a program that outlives this process. */
  spawnDetached(command: string, args: string[]): void;
  /** Called once per version, when its staged app is checked and ready. */
  onReady(version: string): void;
  log(message: string): void;
}

/**
 * Waits for the app to exit, then puts the staged app where the running one
 * was. A failed move puts the old app back. Arguments: pid, bundle, staged
 * app, a scratch path for the old app, and 1 to reopen the app afterwards.
 */
export const SWAP_SCRIPT = `
pid="$1"; bundle="$2"; staged="$3"; old="$4"; reopen="$5"
waited=0
while kill -0 "$pid" 2>/dev/null; do
  waited=$((waited + 1))
  [ "$waited" -gt 300 ] && exit 1
  sleep 0.2
done
rm -rf "$old"
if mv "$bundle" "$old"; then
  if mv "$staged" "$bundle"; then rm -rf "$old"; else mv "$old" "$bundle"; fi
fi
if [ "$reopen" = 1 ]; then /usr/bin/open "$bundle"; fi
`;

export class Updater {
  private staged: { version: string; app: string } | null = null;
  private checking = false;
  private cleaned = false;
  /** Whether the swap reopens the app. Set when the person asks to restart. */
  reopen = false;

  constructor(private readonly deps: UpdaterDeps) {}

  /** The version that is downloaded and waiting for the app to exit, or null. */
  get readyVersion(): string | null {
    return this.staged?.version ?? null;
  }

  /**
   * Looks for a newer build and stages it. Never rejects: a failure is
   * logged, the running app is left alone, and the next check starts over.
   */
  async check(): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    try {
      await this.stageNewer();
    } catch (error) {
      this.deps.log(`Update check failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.checking = false;
    }
  }

  /** Starts the swap when an update is staged. Call as the app quits; calling it twice starts one swap. */
  applyOnQuit(): void {
    if (this.staged === null) return;
    const { app } = this.staged;
    this.staged = null;
    const old = join(this.deps.updatesDir, 'replaced.app');
    this.deps.spawnDetached('/bin/sh', ['-c', SWAP_SCRIPT, 'sh', String(this.deps.pid), this.deps.bundle, app, old, this.reopen ? '1' : '0']);
  }

  private async stageNewer(): Promise<void> {
    const { deps } = this;
    if (!this.cleaned) {
      // Downloads and staged apps from an earlier run are never reused.
      await rm(deps.updatesDir, { recursive: true, force: true });
      this.cleaned = true;
    }
    const response = await deps.fetch(`${deps.releaseUrl}/latest.json`);
    if (!response.ok) throw new Error(`latest.json answered ${response.status}`);
    const manifest = parseManifest(await response.text());
    if (manifest === null) throw new Error('latest.json is not a manifest this version reads');
    if (!isNewer(manifest.version, this.staged?.version ?? deps.currentVersion)) return;

    const dir = join(deps.updatesDir, manifest.version);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    const zip = join(dir, manifest.file);
    await this.download(`${deps.releaseUrl}/${manifest.file}`, zip, manifest);
    const unpacked = join(dir, 'app');
    await deps.run('/usr/bin/ditto', ['-x', '-k', zip, unpacked]);
    await rm(zip, { force: true });

    const apps = (await readdir(unpacked)).filter((name) => name.endsWith('.app'));
    if (apps.length !== 1) throw new Error(`the zip holds ${apps.length} apps, expected 1`);
    const app = join(unpacked, apps[0]!);
    const plist = join(app, 'Contents', 'Info.plist');
    const id = (await deps.run('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', plist])).trim();
    if (id !== deps.bundleId) throw new Error(`the zip holds an app with identifier ${id}, expected ${deps.bundleId}`);
    const version = (await deps.run('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', plist])).trim();
    if (version !== manifest.version) throw new Error(`the zip holds version ${version}, the manifest says ${manifest.version}`);
    // Apple silicon refuses to start an app whose signature does not match its files.
    await deps.run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);

    const earlier = this.staged;
    this.staged = { version: manifest.version, app };
    if (earlier) await rm(join(deps.updatesDir, earlier.version), { recursive: true, force: true });
    deps.log(`Version ${manifest.version} is downloaded and replaces ${deps.currentVersion} when the app quits`);
    deps.onReady(manifest.version);
  }

  /** Writes the zip to `path`, refusing one whose length or sha256 differs from the manifest. */
  private async download(url: string, path: string, manifest: UpdateManifest): Promise<void> {
    const response = await this.deps.fetch(url);
    if (!response.ok || response.body === null) throw new Error(`${manifest.file} answered ${response.status}`);
    const hash = createHash('sha256');
    let length = 0;
    const file = await open(path, 'w');
    try {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        length += chunk.length;
        if (length > manifest.size) throw new Error(`${manifest.file} is longer than the ${manifest.size} bytes the manifest gives`);
        hash.update(chunk);
        await file.write(chunk);
      }
    } finally {
      await file.close();
    }
    if (length !== manifest.size) throw new Error(`${manifest.file} is ${length} bytes, the manifest says ${manifest.size}`);
    const sha256 = hash.digest('hex');
    if (sha256 !== manifest.sha256) throw new Error(`${manifest.file} has sha256 ${sha256}, the manifest says ${manifest.sha256}`);
  }
}
