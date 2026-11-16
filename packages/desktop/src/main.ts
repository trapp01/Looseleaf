/**
 * The Electron main process: one window hosting the built web client from
 * app://looseleaf, the native menu, and the bridge's IPC handlers. It knows
 * nothing about notes.
 *
 * Unpackaged runs read three environment variables: LOOSELEAF_WEB_URL loads a
 * development server instead of the built files, LOOSELEAF_WEB_DIR serves another
 * folder of built files, and LOOSELEAF_USER_DATA_DIR keeps the profile elsewhere.
 * `--smoke` hides the window, prints the page's `smoke:` title as one line of JSON
 * and quits; scripts/smoke.ts drives it. Packaged builds ignore all four.
 */
import { app, BrowserWindow, dialog, ipcMain, Menu, protocol, screen, session, shell, type WebContents } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHandlers } from './ipc.js';
import { CHANNELS } from './channels.js';
import { menuTemplate } from './menu.js';
import { APP_HOST, APP_SCHEME, APP_URL, contentTypeFor, findWebFile, isAppUrl } from './web-client.js';
import { loadWindowState, MIN_HEIGHT, MIN_WIDTH, saveWindowState } from './window-state.js';

const dev = !app.isPackaged;
const devWebUrl = dev ? process.env.LOOSELEAF_WEB_URL || undefined : undefined;
const webDir = app.isPackaged
  ? join(process.resourcesPath, 'web')
  : resolve(process.env.LOOSELEAF_WEB_DIR || join(app.getAppPath(), '../web/dist'));
const smoke = dev && process.argv.includes('--smoke');
const SMOKE_TIMEOUT_MS = 30_000;

if (dev && process.env.LOOSELEAF_USER_DATA_DIR) app.setPath('userData', resolve(process.env.LOOSELEAF_USER_DATA_DIR));
app.enableSandbox();

// Standard + secure gives the page a stable origin and a secure context (IndexedDB, crypto.subtle).
// Service workers stay off: the files are already local, and a worker would serve a stale client after an update.
protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, codeCache: true },
  },
]);

let mainWindow: BrowserWindow | null = null;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin' || smoke) app.quit();
  });
  app.on('activate', () => {
    if (app.isReady() && BrowserWindow.getAllWindows().length === 0) createWindow();
  });
  app.on('web-contents-created', (_event, contents) => guardNavigation(contents));
  app.whenReady().then(start).catch((error: unknown) => {
    console.error(error);
    app.exit(1);
  });
}

function start(): void {
  app.setAboutPanelOptions({ applicationName: 'Looseleaf', applicationVersion: app.getVersion() });
  serveWebClient();
  allowOnlyClipboardPermissions();
  registerIpc();
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      menuTemplate(process.platform, (command) => mainWindow?.webContents.send(CHANNELS.menuCommand, command)),
    ),
  );
  createWindow();
}

function serveWebClient(): void {
  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url);
    const file = url.host === APP_HOST ? await findWebFile(webDir, url.pathname) : null;
    if (!file) {
      return new Response(missingClientPage(), { status: 404, headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    return new Response(new Uint8Array(await readFile(file)), { headers: { 'content-type': contentTypeFor(file) } });
  });
}

function missingClientPage(): string {
  return `<!doctype html><meta charset="utf-8"><title>Looseleaf</title>
<body style="font: 14px system-ui; padding: 48px">
<h1 style="font-size: 18px">The web client is not built</h1>
<p>No index.html in ${escapeHtml(webDir)}. Run <code>pnpm --filter @looseleaf/web build</code>, then reopen Looseleaf.</p>`;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
}

function allowOnlyClipboardPermissions(): void {
  const allowed = new Set(['clipboard-read', 'clipboard-sanitized-write']);
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback, details) => {
    const allow = allowed.has(permission) && isAppUrl(details.requestingUrl, devWebUrl);
    if (!allow) console.warn(`Denied the "${permission}" permission to ${details.requestingUrl}`);
    callback(allow);
  });
  session.defaultSession.setPermissionCheckHandler(
    (_contents, permission, requestingOrigin) => allowed.has(permission) && isAppUrl(requestingOrigin, devWebUrl),
  );
}

function registerIpc(): void {
  const handlers = createHandlers({
    platform: process.platform,
    homeDir: app.getPath('home'),
    env: process.env,
    saveFolder: app.getPath('downloads'),
    writeFile: (path, bytes) => writeFile(path, bytes),
    mirrorSettingFile: join(app.getPath('userData'), 'mirror-folder.json'),
  });
  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      const senderUrl = event.senderFrame?.url ?? '';
      if (!isAppUrl(senderUrl, devWebUrl)) {
        throw new Error(`Refused ${channel} from ${senderUrl || 'a frame that has gone away'}`);
      }
      const window = BrowserWindow.fromWebContents(event.sender);
      if (!window) throw new Error(`Refused ${channel}: the calling page has no window`);
      return handler(
        {
          showSaveDialog: async (defaultPath, filters) =>
            (await dialog.showSaveDialog(window, { defaultPath, filters })).filePath || null,
          showFolderDialog: async () => {
            const result = await dialog.showOpenDialog(window, { properties: ['openDirectory'] });
            return result.canceled ? null : (result.filePaths[0] ?? null);
          },
          printToPdf: () => event.sender.printToPDF({ printBackground: true }),
        },
        args,
      );
    });
  }
}

function createWindow(): void {
  const stateFile = join(app.getPath('userData'), 'window-state.json');
  const state = loadWindowState(stateFile, screen.getAllDisplays().map((d) => d.workArea));
  const mac = process.platform === 'darwin';
  const window = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    show: false,
    title: 'Looseleaf',
    // On macOS the web client draws the title bar; the traffic lights sit centred in its 36 px.
    titleBarStyle: mac ? 'hidden' : 'default',
    trafficLightPosition: mac ? { x: 14, y: 11 } : undefined,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  mainWindow = window;
  if (state.maximized) window.maximize();

  window.on('close', () => saveWindowState(stateFile, window.getNormalBounds(), window.isMaximized()));
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null;
  });
  if (smoke) reportSmokeResult(window);
  else window.once('ready-to-show', () => window.show());

  window.loadURL(devWebUrl ?? APP_URL).catch((error: unknown) => {
    console.error(`Could not load ${devWebUrl ?? APP_URL}:`, error);
  });
}

/** Keeps every page on the app's origin; http(s) and mailto links open in the system browser. */
function guardNavigation(contents: WebContents): void {
  const openOutside = (url: string) => {
    if (/^(https?|mailto):/i.test(url)) shell.openExternal(url).catch((error: unknown) => console.error(error));
  };
  contents.setWindowOpenHandler(({ url }) => {
    openOutside(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, url) => {
    if (isAppUrl(url, devWebUrl)) return;
    event.preventDefault();
    openOutside(url);
  });
  contents.on('will-redirect', (event, url) => {
    if (!isAppUrl(url, devWebUrl)) event.preventDefault();
  });
  contents.on('will-attach-webview', (event) => event.preventDefault());
}

function reportSmokeResult(window: BrowserWindow): void {
  const timer = setTimeout(() => {
    process.stdout.write(`${JSON.stringify({ error: `no smoke: title within ${SMOKE_TIMEOUT_MS} ms` })}\n`);
    app.exit(1);
  }, SMOKE_TIMEOUT_MS);
  window.webContents.on('page-title-updated', (_event, title) => {
    if (!title.startsWith('smoke:')) return;
    clearTimeout(timer);
    process.stdout.write(`${title.slice('smoke:'.length)}\n`);
    app.quit();
  });
}
