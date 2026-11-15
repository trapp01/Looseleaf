/**
 * Launches the built shell twice against a stub web client and checks, from
 * inside the page, what the real web client relies on: the app:// origin, a
 * secure context, IndexedDB that survives a restart, the bridge, plain-http
 * fetch and ws:// to a local server, and no Node globals. Run with
 * `pnpm --filter @looseleaf/desktop smoke` (it builds first). Needs a desktop session.
 *
 * `looseleaf-smoke.test` is mapped to 127.0.0.1 inside Chromium so one request
 * goes to a host that is not loopback by name, the way a tailnet address is.
 */
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const packageDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const electronPath = createRequire(import.meta.url)('electron') as string;
const MAPPED_HOST = 'looseleaf-smoke.test';
const LAUNCH_TIMEOUT_MS = 60_000;

interface PageReport {
  origin: string;
  secureContext: boolean;
  shellKind: string | null;
  shellPlatform: string | null;
  nodeGlobals: Record<string, string>;
  indexedDb: { before: string | null; wrote: string } | { error: string };
  fetch: Record<string, string>;
  webSocket: Record<string, string>;
  ipcRefusesUngrantedFolder: string;
}

function stubPage(port: number): string {
  return `<!doctype html>
<meta charset="utf-8">
<title>smoke stub</title>
<script>
const port = ${port};
const hosts = ['localhost', '${MAPPED_HOST}'];
const withTimeout = (promise, ms) =>
  Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), ms))]);

function idb() {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('looseleaf-smoke', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('kv');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const read = db.transaction('kv').objectStore('kv').get('token');
      read.onerror = () => reject(read.error);
      read.onsuccess = () => {
        const wrote = 'token-' + Date.now() + '-' + Math.random().toString(36).slice(2);
        const tx = db.transaction('kv', 'readwrite');
        tx.objectStore('kv').put(wrote, 'token');
        tx.oncomplete = () => { db.close(); resolve({ before: read.result ?? null, wrote }); };
        tx.onerror = () => reject(tx.error);
      };
    };
  });
}

function socket(host) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://' + host + ':' + port + '/sync');
    ws.onopen = () => ws.send('ping');
    ws.onmessage = (event) => { resolve(String(event.data)); ws.close(); };
    ws.onerror = () => reject(new Error('WebSocket error'));
  });
}

const settle = (promise) => withTimeout(promise, 8000).then((v) => v, (e) => 'error: ' + (e && e.message || e));

(async () => {
  const report = {
    origin: location.origin,
    secureContext: window.isSecureContext,
    shellKind: window.looseleafShell ? window.looseleafShell.kind : null,
    shellPlatform: window.looseleafShell ? window.looseleafShell.platform : null,
    nodeGlobals: { require: typeof require, process: typeof process, module: typeof module, Buffer: typeof Buffer, global: typeof global },
    indexedDb: await idb().catch((e) => ({ error: String(e) })),
    fetch: {},
    webSocket: {},
    ipcRefusesUngrantedFolder: await settle(window.looseleafShell.listOneNoteFiles('/tmp').then(() => 'listed /tmp')),
  };
  for (const host of hosts) {
    report.fetch[host] = await settle(fetch('http://' + host + ':' + port + '/ping').then((r) => r.text()));
    report.webSocket[host] = await settle(socket(host));
  }
  document.title = 'smoke:' + JSON.stringify(report);
})();
</script>
`;
}

async function startServer(): Promise<Server> {
  const server = createServer((request, response) => {
    response.writeHead(request.url === '/ping' ? 200 : 404, {
      'content-type': 'text/plain',
      'access-control-allow-origin': '*',
    });
    response.end(request.url === '/ping' ? 'pong' : 'not found');
  });
  const sockets = new WebSocketServer({ server, path: '/sync' });
  sockets.on('connection', (ws) => ws.on('message', () => ws.send('pong')));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

function launch(webDir: string, userDataDir: string): Promise<PageReport> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, LOOSELEAF_WEB_DIR: webDir, LOOSELEAF_USER_DATA_DIR: userDataDir };
    delete env.LOOSELEAF_WEB_URL;
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(electronPath, [packageDir, '--smoke', `--host-resolver-rules=MAP ${MAPPED_HOST} 127.0.0.1`], {
      env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Electron did not finish within ${LAUNCH_TIMEOUT_MS} ms.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, LAUNCH_TIMEOUT_MS);
    child.on('error', reject);
    child.on('exit', (code) => {
      clearTimeout(timer);
      const line = stdout.trim().split('\n').filter((l) => l.startsWith('{')).pop();
      if (code !== 0 || !line) {
        reject(new Error(`Electron exited with ${code}.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
        return;
      }
      if (stderr.trim()) console.log(`Electron stderr:\n${stderr.trim()}\n`);
      resolve(JSON.parse(line) as PageReport);
    });
  });
}

function checks(first: PageReport, second: PageReport): Array<[string, boolean, unknown]> {
  const firstDb = first.indexedDb;
  const secondDb = second.indexedDb;
  const persisted = 'wrote' in firstDb && 'before' in secondDb && secondDb.before === firstDb.wrote;
  return [
    ['origin is app://looseleaf', first.origin === 'app://looseleaf', first.origin],
    ['window.isSecureContext', first.secureContext === true, first.secureContext],
    ["looseleafShell.kind === 'desktop'", first.shellKind === 'desktop', `${first.shellKind} on ${first.shellPlatform}`],
    ['IndexedDB opens (first launch starts empty)', 'before' in firstDb && firstDb.before === null, firstDb],
    ['IndexedDB persists across two launches', persisted, secondDb],
    ...Object.entries(first.fetch).map(([host, result]): [string, boolean, unknown] => [
      `fetch http://${host}`,
      result === 'pong',
      result,
    ]),
    ...Object.entries(first.webSocket).map(([host, result]): [string, boolean, unknown] => [
      `WebSocket ws://${host}`,
      result === 'pong',
      result,
    ]),
    [
      'no Node globals in the page',
      Object.values(first.nodeGlobals).every((t) => t === 'undefined'),
      first.nodeGlobals,
    ],
    [
      'IPC works and refuses a folder that was never chosen',
      first.ipcRefusesUngrantedFolder.includes('is not inside a folder chosen'),
      first.ipcRefusesUngrantedFolder,
    ],
  ];
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'looseleaf-smoke-'));
  const server = await startServer();
  try {
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('The test server has no port');
    const webDir = join(root, 'web');
    await mkdir(webDir);
    await writeFile(join(webDir, 'index.html'), stubPage(address.port));
    const userDataDir = join(root, 'user-data');
    const first = await launch(webDir, userDataDir);
    const second = await launch(webDir, userDataDir);
    let failed = 0;
    for (const [name, ok, detail] of checks(first, second)) {
      if (!ok) failed++;
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${JSON.stringify(detail)}`);
    }
    console.log(failed === 0 ? '\nsmoke passed' : `\nsmoke failed: ${failed} check(s)`);
    process.exitCode = failed === 0 ? 0 : 1;
  } finally {
    server.closeAllConnections();
    server.close();
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
