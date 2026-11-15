/**
 * The TipTap extension list for one text container: the model's rich-text
 * extensions bound to the container's Y.XmlFragment, with the browser-only
 * parts the model cannot hold: pictures drawn from the blob URL cache, To Do
 * checkboxes that toggle on click, Tab indenting through the command table,
 * Cmd/Ctrl-click on links, and paste or drop of pictures and files.
 */
import { Extension, type AnyExtension } from '@tiptap/core';
import Collaboration from '@tiptap/extension-collaboration';
import { Plugin } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';
import { yUndoPluginKey } from 'y-prosemirror';
import type * as Y from 'yjs';
import { richTextExtensions } from '@looseleaf/model';
import type { BlobUrlCache } from './blob-urls.js';
import type { CommandTable } from '../commands/command-table.js';
import { imageSize } from './files.js';
import { openLink } from './links.js';

export interface TextEditorEnv {
  blobs: BlobUrlCache;
  commands: CommandTable;
  putBlob(bytes: Uint8Array): Promise<string>;
  /** Files that are not pictures, dropped or pasted into this container. */
  addFiles(files: File[]): void;
}

/** Widest a pasted picture starts inside text, in px. */
const MAX_INLINE_PICTURE_WIDTH = 480;
/** The To Do checkbox sits in this much space at a paragraph's left, in px. */
const CHECKBOX_HIT_PX = 22;

export function textEditorExtensions(fragment: Y.XmlFragment, env: TextEditorEnv): AnyExtension[] {
  const base = richTextExtensions.map((ext) => (ext.name === 'image' ? pictureWithBlob(ext, env.blobs) : ext));
  return [
    ...base,
    // Yjs history for the whole page lives in PageSession; the per-editor undo plugin is left out.
    Collaboration.extend({
      addProseMirrorPlugins() {
        return (this.parent?.() ?? []).filter((p) => (p.spec as { key?: unknown }).key !== yUndoPluginKey);
      },
      addKeyboardShortcuts: () => ({}),
      addCommands: () => ({}),
    }).configure({ fragment }),
    pageKeys(env.commands),
    browserBehaviour(env),
  ];
}

function pageKeys(commands: CommandTable): AnyExtension {
  return Extension.create({
    name: 'pageKeys',
    priority: 50,
    addKeyboardShortcuts() {
      return {
        Tab: () => {
          commands.run('indent');
          return true;
        },
        'Shift-Tab': () => {
          commands.run('outdent');
          return true;
        },
      };
    },
  });
}

function pictureWithBlob(ext: AnyExtension, blobs: BlobUrlCache): AnyExtension {
  return (ext as ReturnType<typeof Extension.create>).extend({
    addNodeView() {
      return ({ node }: { node: PMNode }) => {
        const dom = document.createElement('div');
        dom.className = 'inline-picture';
        const img = document.createElement('img');
        img.draggable = false;
        dom.append(img);
        let current = node;
        let hash: string | null = null;
        const show = () => {
          const state = hash ? blobs.state(hash) : { status: 'missing' as const };
          dom.dataset.state = state.status;
          if (state.status === 'ready') img.src = state.url;
          else img.removeAttribute('src');
        };
        const bind = (n: PMNode) => {
          current = n;
          const next = typeof n.attrs.blob === 'string' ? n.attrs.blob : null;
          if (next !== hash) {
            if (hash) blobs.release(hash);
            hash = next;
            if (hash) blobs.acquire(hash, String(n.attrs.mime ?? 'image/png'));
          }
          img.alt = n.attrs.alt ?? '';
          const w = Number(n.attrs.width) || 0;
          const h = Number(n.attrs.height) || 0;
          img.style.width = w ? `${w}px` : '';
          img.style.aspectRatio = w && h ? `${w} / ${h}` : '';
          show();
        };
        const unsubscribe = blobs.subscribe(show);
        bind(node);
        return {
          dom,
          update: (n: PMNode) => {
            if (n.type !== current.type) return false;
            bind(n);
            return true;
          },
          destroy: () => {
            unsubscribe();
            if (hash) blobs.release(hash);
          },
        };
      };
    },
  });
}

function browserBehaviour(env: TextEditorEnv): AnyExtension {
  return Extension.create({
    name: 'browserBehaviour',
    addProseMirrorPlugins() {
      return [
        new Plugin({
          props: {
            handleDOMEvents: {
              mousedown: (view, event) => toggleCheckbox(view, event),
            },
            handleClick: (view, pos, event) => {
              if (!(event.metaKey || event.ctrlKey)) return false;
              const link = view.state.doc.resolve(pos).marks().find((m) => m.type.name === 'link');
              if (!link) return false;
              openLink(link.attrs.href);
              return true;
            },
            handlePaste: (view, event) => takeFiles(view, [...(event.clipboardData?.files ?? [])], null, env),
            handleDrop: (view, event) => {
              const files = [...((event as DragEvent).dataTransfer?.files ?? [])];
              const at = view.posAtCoords({ left: (event as DragEvent).clientX, top: (event as DragEvent).clientY });
              return takeFiles(view, files, at?.pos ?? null, env);
            },
          },
        }),
      ];
    },
  });
}

function toggleCheckbox(view: EditorView, event: MouseEvent): boolean {
  const target = event.target as HTMLElement | null;
  const para = target?.closest?.('[data-tag="todo"]') as HTMLElement | null;
  if (!para || !view.dom.contains(para)) return false;
  if (event.clientX - para.getBoundingClientRect().left > CHECKBOX_HIT_PX) return false;
  const pos = view.posAtDOM(para, 0) - 1;
  const node = view.state.doc.nodeAt(pos);
  if (!node || (node.type.name !== 'paragraph' && node.type.name !== 'heading')) return false;
  view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, checked: !node.attrs.checked }));
  event.preventDefault();
  return true;
}

/** Pictures go into the text at `pos` (or the caret); other files become file containers. */
function takeFiles(view: EditorView, files: File[], pos: number | null, env: TextEditorEnv): boolean {
  if (files.length === 0) return false;
  const pictures = files.filter((f) => f.type.startsWith('image/'));
  const others = files.filter((f) => !f.type.startsWith('image/'));
  if (others.length > 0) env.addFiles(others);
  void (async () => {
    for (const file of pictures) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const [blob, size] = await Promise.all([env.putBlob(bytes), imageSize(file)]);
      const scale = Math.min(1, MAX_INLINE_PICTURE_WIDTH / size.width);
      const node = view.state.schema.nodes.image!.create({
        blob,
        mime: file.type,
        width: Math.round(size.width * scale),
        height: Math.round(size.height * scale),
        alt: file.name,
      });
      const at = pos ?? view.state.selection.to;
      view.dispatch(view.state.tr.insert(Math.min(at, view.state.doc.content.size), node));
    }
  })().catch((error: unknown) => console.error('Could not add the picture', error));
  return true;
}
