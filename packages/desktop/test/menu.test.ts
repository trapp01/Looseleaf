import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { MenuItemConstructorOptions } from 'electron';
import { describe, expect, it } from 'vitest';
import type { MenuCommand } from '../../web/src/shell-bridge.js';
import { menuTemplate } from '../src/menu.js';

/** The MenuCommand union as written in shell-bridge.ts, so a new command fails this test until it has a menu item. */
function bridgeCommands(): string[] {
  const source = readFileSync(fileURLToPath(new URL('../../web/src/shell-bridge.ts', import.meta.url)), 'utf8');
  const union = /export type MenuCommand\s*=([^;]*);/.exec(source)?.[1];
  if (!union) throw new Error('MenuCommand not found in shell-bridge.ts');
  return [...union.matchAll(/'([^']+)'/g)].map((m) => m[1] ?? '');
}

function items(template: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return template.flatMap((item) => [item, ...(Array.isArray(item.submenu) ? items(item.submenu) : [])]);
}

function clickAll(platform: NodeJS.Platform): Map<string, MenuCommand[]> {
  const byLabel = new Map<string, MenuCommand[]>();
  let current: MenuCommand[] = [];
  const template = menuTemplate(platform, (command) => current.push(command));
  for (const item of items(template)) {
    if (!item.click) continue;
    current = [];
    (item.click as unknown as () => void)();
    byLabel.set(`${item.label}${item.visible === false ? ' (hidden)' : ''}`, current);
  }
  return byLabel;
}

describe.each(['darwin', 'win32', 'linux'] as const)('menu on %s', (platform) => {
  const template = menuTemplate(platform, () => undefined);
  const commands = new Set(bridgeCommands());

  it('has only items with a native role, a submenu, a separator, or one MenuCommand', () => {
    for (const [label, sent] of clickAll(platform)) {
      expect(sent, label).toHaveLength(1);
      expect(commands.has(sent[0] ?? ''), `${label} sends ${sent[0]}`).toBe(true);
    }
    for (const item of items(template)) {
      const kind = item.type === 'separator' ? 'separator' : item.role ? 'role' : item.click ? 'command' : item.submenu ? 'submenu' : 'none';
      expect(kind, JSON.stringify(item.label ?? item.role)).not.toBe('none');
    }
  });

  it('reaches every MenuCommand in shell-bridge.ts', () => {
    const reachable = new Set([...clickAll(platform).values()].flat());
    expect([...commands].filter((c) => !reachable.has(c as MenuCommand))).toEqual([]);
  });

  it('has no empty top-level menus apart from the macOS Help menu', () => {
    for (const menu of template) {
      const size = Array.isArray(menu.submenu) ? menu.submenu.length : 0;
      if (!(platform === 'darwin' && menu.role === 'help')) expect(size, String(menu.label ?? menu.role)).toBeGreaterThan(0);
    }
  });

  it('gives each accelerator to one visible item', () => {
    const accelerators = items(template)
      .filter((item) => item.accelerator && item.visible !== false)
      .map((item) => item.accelerator);
    expect(new Set(accelerators).size).toBe(accelerators.length);
  });
});

describe('menu layout', () => {
  it('follows OneNote for Mac order, with the app menu on macOS only', () => {
    const labels = (platform: NodeJS.Platform) =>
      menuTemplate(platform, () => undefined).map((m) => m.label ?? m.role);
    expect(labels('darwin')).toEqual(['Looseleaf', 'File', 'Edit', 'View', 'Notebooks', 'window', 'help']);
    expect(labels('win32')).toEqual(['File', 'Edit', 'View', 'Notebooks', 'window', 'help']);
  });

  it('puts the asked-for shortcuts on File and Settings', () => {
    const byLabel = new Map(items(menuTemplate('darwin', () => undefined)).map((i) => [i.label, i.accelerator]));
    expect(byLabel.get('New Page')).toBe('CmdOrCtrl+N');
    expect(byLabel.get('New Section')).toBe('CmdOrCtrl+T');
    expect(byLabel.get('Print…')).toBe('CmdOrCtrl+P');
    expect(byLabel.get('Settings…')).toBe('CmdOrCtrl+,');
  });

  it('sends commands through the given function, not a native role, for zoom and undo', () => {
    const sent = clickAll('darwin');
    expect(sent.get('Zoom In')).toEqual(['zoom-in']);
    expect(sent.get('Zoom In (hidden)')).toEqual(['zoom-in']);
    expect(sent.get('Actual Size')).toEqual(['zoom-reset']);
    expect(sent.get('Undo')).toEqual(['undo']);
  });
});
