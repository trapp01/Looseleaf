/**
 * THE command table. Every action a ribbon button, keyboard shortcut, phone
 * formatting bar or native shell menu can trigger is one entry here, and all
 * of them dispatch through `CommandTable.run`. A command reads the focused
 * text editor (if any) and the app's actions from the context it is given;
 * it never reaches into React. `enabled` and `active` drive ribbon state.
 */
import type { Editor } from '@tiptap/core';
import type { TagName } from '@looseleaf/model';
import type { MenuCommand } from '../shell-bridge.js';

/** What the app offers commands that are not text formatting. */
export interface AppActions {
  hasPage(): boolean;
  /** The open page's notebook has a board and the page is not a card on it. */
  canPutOnBoard(): boolean;
  putOnBoard(): void;
  /** The notebook view shows and its notebook has a board. */
  canShowBoardBeside(): boolean;
  boardBesideOpen(): boolean;
  toggleBoardBeside(): void;
  newPage(): void;
  newSection(): void;
  newSectionGroup(): void;
  newNotebook(): void;
  openImport(): void;
  openExport(): void;
  savePdf(): void;
  print(): void;
  canUndo(): boolean;
  canRedo(): boolean;
  undo(): void;
  redo(): void;
  find(): void;
  zoomBy(step: 1 | -1): void;
  zoomReset(): void;
  zoomPageWidth(): void;
  showDeletedNotes(): void;
  openSettings(): void;
  insertPicture(): void;
  insertFile(): void;
  openLinkDialog(): void;
}

export interface CommandContext {
  /** The text editor the caret is in, or was last in, on the open page. */
  editor: Editor | null;
  app: AppActions;
}

export type ParagraphStyleName = 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' | 'citation' | 'quote' | 'code' | 'normal';
export type Alignment = 'left' | 'center' | 'right';

export interface Command {
  label: string;
  /** e.g. "Mod+B", "Mod+Shift+Z", "Alt+Shift+D"; Mod is Cmd on macOS and Ctrl elsewhere. */
  shortcut?: string[];
  needsEditor?: boolean;
  enabled?(ctx: CommandContext, arg?: unknown): boolean;
  active?(ctx: CommandContext, arg?: unknown): boolean;
  run(ctx: CommandContext, arg?: unknown): void;
}

const chain = (ctx: CommandContext) => ctx.editor!.chain().focus();

const mark = (name: string, label: string, toggle: (c: ReturnType<typeof chain>) => ReturnType<typeof chain>, shortcut?: string): Command => ({
  label,
  shortcut: shortcut ? [shortcut] : undefined,
  needsEditor: true,
  active: (ctx) => ctx.editor!.isActive(name),
  run: (ctx) => void toggle(chain(ctx)).run(),
});

function inList(editor: Editor): boolean {
  return editor.isActive('listItem');
}

/** The paragraph style at the caret. */
export function currentStyle(editor: Editor): ParagraphStyleName {
  for (let level = 1; level <= 6; level++) if (editor.isActive('heading', { level })) return `h${level}` as ParagraphStyleName;
  const style = editor.getAttributes('paragraph').style as string | null;
  return style === 'quote' || style === 'code' || style === 'citation' ? style : 'normal';
}

function applyStyle(editor: Editor, style: ParagraphStyleName): void {
  if (style.startsWith('h')) {
    const level = Number(style.slice(1)) as 1 | 2 | 3 | 4 | 5 | 6;
    editor.chain().focus().setNode('heading', { level }).updateAttributes('heading', { style: null }).run();
    return;
  }
  editor
    .chain()
    .focus()
    .setParagraph()
    .updateAttributes('paragraph', { style: style === 'normal' ? null : style })
    .run();
}

/** The tag on the paragraph at the caret, or null. */
export function currentTag(editor: Editor): TagName | null {
  return (editor.getAttributes('paragraph').tag ?? editor.getAttributes('heading').tag ?? null) as TagName | null;
}

/** Sets a tag on every paragraph and heading the selection touches; the same tag again removes it. */
function applyTag(editor: Editor, tag: TagName | null): void {
  const next = tag !== null && currentTag(editor) === tag ? null : tag;
  editor
    .chain()
    .focus()
    .updateAttributes('paragraph', { tag: next, checked: false })
    .updateAttributes('heading', { tag: next, checked: false })
    .run();
}

function insertText(editor: Editor, text: string): void {
  editor.chain().focus().insertContent(text).run();
}

const tagCommand = (tag: TagName, label: string, shortcut: string): Command => ({
  label,
  shortcut: [shortcut],
  needsEditor: true,
  active: (ctx) => currentTag(ctx.editor!) === tag,
  run: (ctx) => applyTag(ctx.editor!, tag),
});

const styleCommand = (style: ParagraphStyleName, label: string, shortcut?: string): Command => ({
  label,
  shortcut: shortcut ? [shortcut] : undefined,
  needsEditor: true,
  active: (ctx) => currentStyle(ctx.editor!) === style,
  run: (ctx) => applyStyle(ctx.editor!, style),
});

const tableCommand = (label: string, run: (c: ReturnType<typeof chain>) => ReturnType<typeof chain>): Command => ({
  label,
  needsEditor: true,
  enabled: (ctx) => ctx.editor!.isActive('table'),
  run: (ctx) => void run(chain(ctx)).run(),
});

const appCommand = (label: string, run: (app: AppActions) => void, shortcut?: string[], enabled?: (app: AppActions) => boolean): Command => ({
  label,
  shortcut,
  enabled: enabled ? (ctx) => enabled(ctx.app) : undefined,
  run: (ctx) => run(ctx.app),
});

const pageCommand = (label: string, run: (app: AppActions) => void, shortcut?: string[]): Command =>
  appCommand(label, run, shortcut, (app) => app.hasPage());

export const COMMANDS = {
  // Clipboard. Cut and copy act on the browser selection; paste reads the clipboard API where the browser offers it.
  cut: { label: 'Cut', needsEditor: true, run: () => void document.execCommand('cut') },
  copy: { label: 'Copy', needsEditor: true, run: () => void document.execCommand('copy') },
  paste: {
    label: 'Paste',
    needsEditor: true,
    enabled: () => typeof navigator !== 'undefined' && !!navigator.clipboard?.read,
    run: (ctx) => void pasteFromClipboard(ctx.editor!, false),
  },
  'paste-text': {
    label: 'Paste text only',
    needsEditor: true,
    enabled: () => typeof navigator !== 'undefined' && !!navigator.clipboard?.readText,
    run: (ctx) => void pasteFromClipboard(ctx.editor!, true),
  },

  bold: mark('bold', 'Bold', (c) => c.toggleBold(), 'Mod+B'),
  italic: mark('italic', 'Italic', (c) => c.toggleItalic(), 'Mod+I'),
  underline: mark('underline', 'Underline', (c) => c.toggleUnderline(), 'Mod+U'),
  strike: mark('strike', 'Strikethrough', (c) => c.toggleStrike(), 'Mod+Shift+S'),
  subscript: mark('subscript', 'Subscript', (c) => c.unsetSuperscript().toggleSubscript(), 'Mod+Equal'),
  superscript: mark('superscript', 'Superscript', (c) => c.unsetSubscript().toggleSuperscript(), 'Mod+Shift+Equal'),
  highlight: {
    label: 'Highlight',
    needsEditor: true,
    active: (ctx) => ctx.editor!.isActive('highlight'),
    run: (ctx, color) =>
      void (typeof color === 'string' ? chain(ctx).setHighlight({ color }) : chain(ctx).unsetHighlight()).run(),
  },
  'font-color': {
    label: 'Font colour',
    needsEditor: true,
    run: (ctx, color) =>
      void (typeof color === 'string' ? chain(ctx).setColor(color) : chain(ctx).unsetColor()).run(),
  },
  'font-family': {
    label: 'Font',
    needsEditor: true,
    run: (ctx, family) =>
      void (typeof family === 'string' ? chain(ctx).setFontFamily(family) : chain(ctx).unsetFontFamily()).run(),
  },
  'font-size': {
    label: 'Font size',
    needsEditor: true,
    run: (ctx, size) =>
      void (typeof size === 'number' && size > 0 ? chain(ctx).setFontSize(size) : chain(ctx).unsetFontSize()).run(),
  },
  'clear-formatting': {
    label: 'Clear formatting',
    shortcut: ['Mod+Shift+N'],
    needsEditor: true,
    run: (ctx) => void chain(ctx).unsetAllMarks().setParagraph().updateAttributes('paragraph', { style: null, textAlign: null }).run(),
  },

  'bullet-list': mark('bulletList', 'Bullets', (c) => c.toggleBulletList(), 'Mod+Period'),
  'ordered-list': mark('orderedList', 'Numbering', (c) => c.toggleOrderedList(), 'Mod+Slash'),
  indent: {
    label: 'Increase indent',
    needsEditor: true,
    run: (ctx) => {
      const editor = ctx.editor!;
      if (inList(editor)) editor.chain().focus().sinkListItem('listItem').run();
      else editor.chain().focus().increaseIndent().run();
    },
  },
  outdent: {
    label: 'Decrease indent',
    needsEditor: true,
    run: (ctx) => {
      const editor = ctx.editor!;
      if (inList(editor)) editor.chain().focus().liftListItem('listItem').run();
      else editor.chain().focus().decreaseIndent().run();
    },
  },
  align: {
    label: 'Align',
    needsEditor: true,
    active: (ctx, a) => (a === 'left' ? !['center', 'right'].some((x) => ctx.editor!.isActive({ textAlign: x })) : ctx.editor!.isActive({ textAlign: a })),
    run: (ctx, a) => void chain(ctx).setTextAlign(String(a ?? 'left')).run(),
  },

  'style-h1': styleCommand('h1', 'Heading 1', 'Mod+Alt+1'),
  'style-h2': styleCommand('h2', 'Heading 2', 'Mod+Alt+2'),
  'style-h3': styleCommand('h3', 'Heading 3', 'Mod+Alt+3'),
  'style-h4': styleCommand('h4', 'Heading 4', 'Mod+Alt+4'),
  'style-h5': styleCommand('h5', 'Heading 5', 'Mod+Alt+5'),
  'style-h6': styleCommand('h6', 'Heading 6', 'Mod+Alt+6'),
  'style-citation': styleCommand('citation', 'Citation'),
  'style-quote': styleCommand('quote', 'Quote'),
  'style-code': styleCommand('code', 'Code'),
  'style-normal': styleCommand('normal', 'Normal', 'Mod+Alt+0'),

  'tag-todo': tagCommand('todo', 'To Do', 'Mod+1'),
  'tag-important': tagCommand('important', 'Important', 'Mod+2'),
  'tag-question': tagCommand('question', 'Question', 'Mod+3'),
  'tag-remember': tagCommand('remember', 'Remember for later', 'Mod+4'),
  'tag-definition': tagCommand('definition', 'Definition', 'Mod+5'),
  'tag-remove': {
    label: 'Remove tag',
    shortcut: ['Mod+0'],
    needsEditor: true,
    run: (ctx) => applyTag(ctx.editor!, null),
  },

  'insert-table': {
    label: 'Table',
    needsEditor: true,
    run: (ctx, size) => {
      const { rows, cols } = (size as { rows: number; cols: number } | undefined) ?? { rows: 2, cols: 2 };
      chain(ctx).insertTable({ rows, cols, withHeaderRow: false }).run();
    },
  },
  'table-row-above': tableCommand('Insert above', (c) => c.addRowBefore()),
  'table-row-below': tableCommand('Insert below', (c) => c.addRowAfter()),
  'table-column-left': tableCommand('Insert left', (c) => c.addColumnBefore()),
  'table-column-right': tableCommand('Insert right', (c) => c.addColumnAfter()),
  'table-delete-row': tableCommand('Delete row', (c) => c.deleteRow()),
  'table-delete-column': tableCommand('Delete column', (c) => c.deleteColumn()),
  'table-delete': tableCommand('Delete table', (c) => c.deleteTable()),
  'table-merge': tableCommand('Merge cells', (c) => c.mergeCells()),
  'table-split': tableCommand('Split cell', (c) => c.splitCell()),
  link: {
    label: 'Link',
    shortcut: ['Mod+K'],
    needsEditor: true,
    active: (ctx) => ctx.editor!.isActive('link'),
    run: (ctx, href) => {
      if (href === undefined) return ctx.app.openLinkDialog();
      if (typeof href === 'string' && href.trim() !== '') chain(ctx).extendMarkRange('link').setLink({ href: href.trim() }).run();
      else chain(ctx).extendMarkRange('link').unsetLink().run();
    },
  },
  'insert-date': {
    label: 'Date',
    shortcut: ['Alt+Shift+D'],
    needsEditor: true,
    run: (ctx) => insertText(ctx.editor!, new Date().toLocaleDateString(undefined, { dateStyle: 'medium' })),
  },
  'insert-date-time': {
    label: 'Date & Time',
    shortcut: ['Alt+Shift+F'],
    needsEditor: true,
    run: (ctx) => insertText(ctx.editor!, new Date().toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })),
  },
  'insert-picture': pageCommand('Picture', (app) => app.insertPicture()),
  'insert-file': pageCommand('File', (app) => app.insertFile()),
  'put-on-board': appCommand('Put on board', (app) => app.putOnBoard(), undefined, (app) => app.canPutOnBoard()),
  'board-beside': {
    label: 'Board beside page',
    enabled: (ctx) => ctx.app.canShowBoardBeside(),
    active: (ctx) => ctx.app.canShowBoardBeside() && ctx.app.boardBesideOpen(),
    run: (ctx) => ctx.app.toggleBoardBeside(),
  },

  undo: appCommand('Undo', (app) => app.undo(), ['Mod+Z'], (app) => app.canUndo()),
  redo: appCommand('Redo', (app) => app.redo(), ['Mod+Shift+Z', 'Mod+Y'], (app) => app.canRedo()),
  'new-page': appCommand('New page', (app) => app.newPage(), ['Mod+N']),
  'new-section': appCommand('New section', (app) => app.newSection()),
  'new-section-group': appCommand('New section group', (app) => app.newSectionGroup()),
  'new-notebook': appCommand('New notebook', (app) => app.newNotebook()),
  'import-onenote': appCommand('Import from OneNote', (app) => app.openImport()),
  export: appCommand('Export', (app) => app.openExport()),
  'save-pdf': pageCommand('Save as PDF', (app) => app.savePdf()),
  print: pageCommand('Print', (app) => app.print(), ['Mod+P']),
  find: appCommand('Search', (app) => app.find(), ['Mod+F']),
  'zoom-in': pageCommand('Zoom in', (app) => app.zoomBy(1), ['Mod+Alt+Equal']),
  'zoom-out': pageCommand('Zoom out', (app) => app.zoomBy(-1), ['Mod+Alt+Minus']),
  'zoom-reset': pageCommand('100%', (app) => app.zoomReset(), ['Mod+Alt+Digit0']),
  'zoom-page-width': pageCommand('Page width', (app) => app.zoomPageWidth()),
  'deleted-notes': appCommand('Deleted notes', (app) => app.showDeletedNotes()),
  settings: appCommand('Settings', (app) => app.openSettings(), ['Mod+Comma']),
} satisfies Record<string, Command>;

export type CommandId = keyof typeof COMMANDS;

/** Each native menu command runs the command with the same job. */
export const MENU_COMMANDS: Record<MenuCommand, CommandId> = {
  'new-page': 'new-page',
  'new-section': 'new-section',
  'new-section-group': 'new-section-group',
  'new-notebook': 'new-notebook',
  'import-onenote': 'import-onenote',
  export: 'export',
  'save-pdf': 'save-pdf',
  print: 'print',
  undo: 'undo',
  redo: 'redo',
  find: 'find',
  'zoom-in': 'zoom-in',
  'zoom-out': 'zoom-out',
  'zoom-reset': 'zoom-reset',
  'deleted-notes': 'deleted-notes',
  settings: 'settings',
};

async function pasteFromClipboard(editor: Editor, textOnly: boolean): Promise<void> {
  editor.commands.focus();
  if (!textOnly && navigator.clipboard.read) {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      if (item.types.includes('text/html')) {
        editor.view.pasteHTML(await (await item.getType('text/html')).text());
        return;
      }
    }
  }
  editor.view.pasteText(await navigator.clipboard.readText());
}

interface ParsedShortcut {
  mod: boolean;
  shift: boolean;
  alt: boolean;
  code: string;
}

/** "Mod+Shift+Z" → its parts; the key is a KeyboardEvent.code ("KeyZ", "Digit1", "Equal"). */
export function parseShortcut(spec: string): ParsedShortcut {
  const parts = spec.split('+');
  const key = parts.pop()!;
  const code = /^[A-Z]$/.test(key) ? `Key${key}` : /^\d$/.test(key) ? `Digit${key}` : key;
  return { mod: parts.includes('Mod'), shift: parts.includes('Shift'), alt: parts.includes('Alt'), code };
}

interface KeyLike {
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

export function matchesShortcut(event: KeyLike, spec: string, isMac: boolean): boolean {
  const s = parseShortcut(spec);
  const mod = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  const noMod = !event.metaKey && !event.ctrlKey;
  return event.code === s.code && (s.mod ? mod : noMod) && event.shiftKey === s.shift && event.altKey === s.alt;
}

/** "⌘B" on macOS, "Ctrl+B" elsewhere; for tooltips. */
export function shortcutLabel(spec: string, isMac: boolean): string {
  const s = parseShortcut(spec);
  const key = s.code.replace(/^Key|^Digit/, '').replace('Equal', '=').replace('Minus', '-').replace('Period', '.').replace('Slash', '/').replace('Comma', ',');
  if (isMac) return `${s.alt ? '⌥' : ''}${s.shift ? '⇧' : ''}${s.mod ? '⌘' : ''}${key}`;
  return [s.mod ? 'Ctrl' : '', s.alt ? 'Alt' : '', s.shift ? 'Shift' : '', key].filter(Boolean).join('+');
}

export class CommandTable {
  constructor(
    private readonly context: () => CommandContext,
    private readonly isMac: boolean,
  ) {}

  get(id: CommandId): Command {
    return COMMANDS[id];
  }

  isEnabled(id: CommandId, arg?: unknown): boolean {
    const command: Command = COMMANDS[id];
    const ctx = this.context();
    if (command.needsEditor && !ctx.editor) return false;
    return command.enabled ? command.enabled(ctx, arg) : true;
  }

  isActive(id: CommandId, arg?: unknown): boolean {
    const command: Command = COMMANDS[id];
    const ctx = this.context();
    if (!command.active || (command.needsEditor && !ctx.editor)) return false;
    return command.active(ctx, arg);
  }

  /** Runs the command when enabled; returns whether it ran. */
  run(id: CommandId, arg?: unknown): boolean {
    if (!this.isEnabled(id, arg)) return false;
    const command: Command = COMMANDS[id];
    command.run(this.context(), arg);
    return true;
  }

  /** The command a key press triggers, if any. */
  commandForKey(event: KeyLike): CommandId | null {
    for (const [id, command] of Object.entries(COMMANDS) as Array<[CommandId, Command]>) {
      if (command.shortcut?.some((spec) => matchesShortcut(event, spec, this.isMac))) return id;
    }
    return null;
  }

  tooltip(id: CommandId): string {
    const command: Command = COMMANDS[id];
    const first = command.shortcut?.[0];
    return first ? `${command.label} (${shortcutLabel(first, this.isMac)})` : command.label;
  }
}
