/**
 * The native menu bar, in the order OneNote for Mac uses: App, File, Edit,
 * View, Notebooks, Window, Help. Every item either sends a `MenuCommand` to the
 * web client or is a native role. Insert and Format join the bar once
 * `MenuCommand` has items for them; an empty menu would do nothing.
 */
import type { MenuItemConstructorOptions } from 'electron';
import type { MenuCommand } from '../../web/src/shell-bridge.js';

export function menuTemplate(
  platform: NodeJS.Platform,
  send: (command: MenuCommand) => void,
  appName = 'Looseleaf',
): MenuItemConstructorOptions[] {
  const mac = platform === 'darwin';
  const command = (label: string, name: MenuCommand, accelerator?: string): MenuItemConstructorOptions => ({
    label,
    accelerator,
    click: () => send(name),
  });
  const settings = command(mac ? 'Settings…' : 'Settings', 'settings', 'CmdOrCtrl+,');

  const appMenu: MenuItemConstructorOptions = {
    label: appName,
    submenu: [
      { role: 'about' },
      { type: 'separator' },
      settings,
      { type: 'separator' },
      { role: 'services' },
      { type: 'separator' },
      { role: 'hide' },
      { role: 'hideOthers' },
      { role: 'unhide' },
      { type: 'separator' },
      { role: 'quit' },
    ],
  };

  const file: MenuItemConstructorOptions = {
    label: 'File',
    submenu: [
      command('New Page', 'new-page', 'CmdOrCtrl+N'),
      command('New Section', 'new-section', 'CmdOrCtrl+T'),
      command('New Section Group', 'new-section-group'),
      command('New Notebook…', 'new-notebook'),
      { type: 'separator' },
      command('Import from OneNote…', 'import-onenote'),
      command('Export…', 'export'),
      command('Mirror Folder…', 'settings'),
      { type: 'separator' },
      command('Save as PDF…', 'save-pdf'),
      command('Print…', 'print', 'CmdOrCtrl+P'),
      { type: 'separator' },
      ...(mac ? [{ role: 'close' } as const] : [settings, { type: 'separator' } as const, { role: 'quit' } as const]),
    ],
  };

  const edit: MenuItemConstructorOptions = {
    label: 'Edit',
    submenu: [
      command('Undo', 'undo', 'CmdOrCtrl+Z'),
      command('Redo', 'redo', mac ? 'Shift+Cmd+Z' : 'Ctrl+Y'),
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { role: 'selectAll' },
      { type: 'separator' },
      command('Find…', 'find', 'CmdOrCtrl+F'),
    ],
  };

  const view: MenuItemConstructorOptions = {
    label: 'View',
    submenu: [
      command('Zoom In', 'zoom-in', 'CmdOrCtrl+Plus'),
      // Cmd-= is the unshifted key most people press for zoom in; macOS only honours hidden accelerators.
      { ...command('Zoom In', 'zoom-in', 'CmdOrCtrl+='), visible: false, acceleratorWorksWhenHidden: true },
      command('Zoom Out', 'zoom-out', 'CmdOrCtrl+-'),
      command('Actual Size', 'zoom-reset', 'CmdOrCtrl+0'),
      { type: 'separator' },
      { role: 'togglefullscreen' },
    ],
  };

  const notebooks: MenuItemConstructorOptions = {
    label: 'Notebooks',
    submenu: [command('Deleted Notes', 'deleted-notes')],
  };

  const windowMenu: MenuItemConstructorOptions = {
    role: 'window',
    submenu: mac
      ? [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }]
      : [{ role: 'minimize' }, { role: 'close' }],
  };

  // On macOS the Help menu holds the system's menu search; elsewhere it holds About.
  const help: MenuItemConstructorOptions = { role: 'help', submenu: mac ? [] : [{ role: 'about' }] };

  return [...(mac ? [appMenu] : []), file, edit, view, notebooks, windowMenu, help];
}
