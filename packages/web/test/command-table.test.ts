// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Editor } from '@tiptap/core';
import { richTextExtensions } from '@looseleaf/model';
import { COMMANDS, CommandTable, MENU_COMMANDS, matchesShortcut, shortcutLabel, type AppActions, type CommandId } from '../src/commands/command-table.js';

function actions(overrides: Partial<AppActions> = {}): AppActions {
  const noop = () => undefined;
  return {
    hasPage: () => true,
    newPage: noop,
    newSection: noop,
    newSectionGroup: noop,
    newNotebook: noop,
    openImport: noop,
    openExport: noop,
    savePdf: noop,
    print: noop,
    canUndo: () => false,
    canRedo: () => false,
    undo: noop,
    redo: noop,
    find: noop,
    zoomBy: noop,
    zoomReset: noop,
    zoomPageWidth: noop,
    showDeletedNotes: noop,
    openSettings: noop,
    insertPicture: noop,
    insertFile: noop,
    openLinkDialog: noop,
    ...overrides,
  };
}

const key = (code: string, mods: { meta?: boolean; ctrl?: boolean; shift?: boolean; alt?: boolean } = {}) => ({
  code,
  metaKey: !!mods.meta,
  ctrlKey: !!mods.ctrl,
  shiftKey: !!mods.shift,
  altKey: !!mods.alt,
});

let editor: Editor | null = null;
afterEach(() => {
  editor?.destroy();
  editor = null;
});

function withEditor(html: string, app = actions()) {
  editor = new Editor({ extensions: richTextExtensions, content: html });
  editor.commands.selectAll();
  return new CommandTable(() => ({ editor, app }), true);
}

describe('CommandTable', () => {
  it('maps every native menu command to a command in the table', () => {
    for (const id of Object.values(MENU_COMMANDS)) expect(COMMANDS[id]).toBeDefined();
  });

  it('disables text commands without an editor and runs app commands', () => {
    const newPage = vi.fn();
    const table = new CommandTable(() => ({ editor: null, app: actions({ newPage }) }), false);
    expect(table.isEnabled('bold')).toBe(false);
    expect(table.run('bold')).toBe(false);
    expect(table.run('new-page')).toBe(true);
    expect(newPage).toHaveBeenCalledOnce();
    expect(table.isEnabled('undo')).toBe(false);
  });

  it('finds commands by shortcut with Cmd on macOS and Ctrl elsewhere', () => {
    const mac = new CommandTable(() => ({ editor: null, app: actions() }), true);
    const pc = new CommandTable(() => ({ editor: null, app: actions() }), false);
    expect(mac.commandForKey(key('KeyB', { meta: true }))).toBe('bold');
    expect(mac.commandForKey(key('KeyB', { ctrl: true }))).toBe(null);
    expect(pc.commandForKey(key('KeyB', { ctrl: true }))).toBe('bold');
    expect(mac.commandForKey(key('KeyZ', { meta: true, shift: true }))).toBe('redo');
    expect(mac.commandForKey(key('Digit1', { meta: true }))).toBe('tag-todo');
    expect(mac.commandForKey(key('KeyK', { meta: true }))).toBe('link');
    expect(mac.commandForKey(key('KeyF', { meta: true }))).toBe('find');
    expect(mac.commandForKey(key('KeyN', { meta: true }))).toBe('new-page');
    expect(matchesShortcut(key('Equal', { meta: true, alt: true }), 'Mod+Alt+Equal', true)).toBe(true);
    expect(shortcutLabel('Mod+Shift+Z', true)).toBe('⇧⌘Z');
    expect(shortcutLabel('Mod+B', false)).toBe('Ctrl+B');
  });

  it('no two commands share a shortcut', () => {
    const seen = new Map<string, CommandId>();
    for (const [id, command] of Object.entries(COMMANDS) as Array<[CommandId, { shortcut?: string[] }]>) {
      for (const s of command.shortcut ?? []) {
        expect(seen.get(s), `${s} on ${id} and ${seen.get(s)}`).toBeUndefined();
        seen.set(s, id);
      }
    }
  });

  it('toggles marks and reports them active', () => {
    const table = withEditor('<p>Hello</p>');
    table.run('bold');
    expect(editor!.getHTML()).toBe('<p><strong>Hello</strong></p>');
    expect(table.isActive('bold')).toBe(true);
    table.run('font-size', 14);
    expect(editor!.getAttributes('textStyle').fontSize).toBe(14);
  });

  it('indents paragraphs with the model’s indent and list items as list levels', () => {
    const table = withEditor('<p>Plain</p>');
    table.run('indent');
    expect(editor!.getJSON().content![0]!.attrs!.indent).toBe(1);
    table.run('outdent');
    expect(editor!.getJSON().content![0]!.attrs!.indent).toBe(0);

    const lists = withEditor('<ul><li><p>One</p></li><li><p>Two</p></li></ul>');
    editor!.commands.setTextSelection(editor!.state.doc.content.size - 3);
    lists.run('indent');
    expect(editor!.getHTML()).toBe('<ul><li><p>One</p><ul><li><p>Two</p></li></ul></li></ul>');
    lists.run('outdent');
    expect(editor!.getHTML()).toBe('<ul><li><p>One</p></li><li><p>Two</p></li></ul>');
  });

  it('sets a tag, toggles it off with the same tag, and applies styles', () => {
    const table = withEditor('<p>Task</p>');
    table.run('tag-todo');
    expect(editor!.getJSON().content![0]!.attrs).toMatchObject({ tag: 'todo', checked: false });
    expect(table.isActive('tag-todo')).toBe(true);
    table.run('tag-todo');
    expect(editor!.getJSON().content![0]!.attrs!.tag).toBe(null);
    table.run('style-h2');
    expect(editor!.getJSON().content![0]).toMatchObject({ type: 'heading', attrs: { level: 2 } });
    expect(table.isActive('style-h2')).toBe(true);
    table.run('style-quote');
    expect(editor!.getJSON().content![0]).toMatchObject({ type: 'paragraph', attrs: { style: 'quote' } });
  });

  it('inserts a table and enables the table commands inside it', () => {
    const table = withEditor('<p></p>');
    expect(table.isEnabled('table-row-below')).toBe(false);
    table.run('insert-table', { rows: 2, cols: 3 });
    expect(table.isEnabled('table-row-below')).toBe(true);
    table.run('table-row-below');
    const rows = editor!.getJSON().content!.find((n) => n.type === 'table')!.content!;
    expect(rows).toHaveLength(3);
    expect(rows[0]!.content).toHaveLength(3);
  });

  it('opens the link dialog without an address and sets or removes a link with one', () => {
    const openLinkDialog = vi.fn();
    const table = withEditor('<p>site</p>', actions({ openLinkDialog }));
    table.run('link');
    expect(openLinkDialog).toHaveBeenCalledOnce();
    table.run('link', 'https://example.com');
    expect(editor!.getHTML()).toContain('href="https://example.com"');
    table.run('link', '');
    expect(editor!.getHTML()).not.toContain('href');
  });
});
