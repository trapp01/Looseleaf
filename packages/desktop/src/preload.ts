/**
 * Runs in the sandboxed page before the web client and sets
 * `window.looseleafShell`. Every call becomes an IPC message; the main process
 * checks the arguments and the page's origin.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { MenuCommand, ShellBridge } from '../../web/src/shell-bridge.js';
import { CHANNELS } from './channels.js';

function platform(): ShellBridge['platform'] {
  const p = process.platform;
  if (p === 'darwin' || p === 'win32' || p === 'linux') return p;
  throw new Error(`Looseleaf's desktop shell does not run on ${p}`);
}

const bridge: ShellBridge = {
  kind: 'desktop',
  platform: platform(),
  saveFile: (suggestedName, bytes) => ipcRenderer.invoke(CHANNELS.saveFile, suggestedName, bytes),
  savePdf: (suggestedName) => ipcRenderer.invoke(CHANNELS.savePdf, suggestedName),
  findOneNoteBackups: () => ipcRenderer.invoke(CHANNELS.findOneNoteBackups),
  pickFolder: () => ipcRenderer.invoke(CHANNELS.pickFolder),
  listOneNoteFiles: (folder) => ipcRenderer.invoke(CHANNELS.listOneNoteFiles, folder),
  readOneNoteFile: (folder, path) => ipcRenderer.invoke(CHANNELS.readOneNoteFile, folder, path),
  onMenuCommand(listener) {
    if (typeof listener !== 'function') throw new TypeError('onMenuCommand needs a function');
    const forward = (_event: IpcRendererEvent, command: MenuCommand) => listener(command);
    ipcRenderer.on(CHANNELS.menuCommand, forward);
    return () => {
      ipcRenderer.removeListener(CHANNELS.menuCommand, forward);
    };
  },
};

contextBridge.exposeInMainWorld('looseleafShell', bridge);
