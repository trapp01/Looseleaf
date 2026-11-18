/**
 * The "Inbox" pill at the end of each To Do line on the page that is in its
 * board's Inbox, as a ProseMirror decoration, and the line's menu: the pill,
 * right-click on the line and a long press on it (touch and pen) all open
 * the same menu (line-menu.tsx). Which lines get a pill comes from the page
 * session's `inbox` set (page-inbox.ts); this only draws it.
 */
import { Extension, type AnyExtension } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import type { Store } from '../app/store.js';

export interface InboxPills {
  /** The ids of the lines on this page that are in the Inbox. */
  lines: Store<ReadonlySet<string>>;
  openMenu(lineId: string, x: number, y: number): void;
}

const LONG_PRESS_MS = 500;
const MOVE_TOLERANCE_PX = 10;
const key = new PluginKey<DecorationSet>('inboxPills');

/** The pill for one line; the static render of a text body draws the same one. */
export function inboxPill(lineId: string, pills: InboxPills): HTMLElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'inbox-pill';
  button.contentEditable = 'false';
  button.textContent = 'Inbox';
  button.title = 'In the board’s Inbox: make it a card, or keep it as a line';
  button.setAttribute('aria-haspopup', 'menu');
  button.addEventListener('mousedown', (event) => event.preventDefault());
  // A press on the pill is the pill's, not a press that wakes the text under it.
  button.addEventListener('pointerdown', (event) => event.stopPropagation());
  button.addEventListener('click', (event) => {
    event.preventDefault();
    const r = button.getBoundingClientRect();
    pills.openMenu(lineId, r.left, r.bottom + 4);
  });
  return button;
}

function decorations(doc: PMNode, pills: InboxPills): DecorationSet {
  const ids = pills.lines.get();
  if (ids.size === 0) return DecorationSet.empty;
  const found: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== 'paragraph' && node.type.name !== 'heading') return true;
    const lineId = node.attrs.lineId;
    if (typeof lineId === 'string' && ids.has(lineId)) {
      found.push(Decoration.widget(pos + node.nodeSize - 1, () => inboxPill(lineId, pills), { side: 1, key: `inbox-${lineId}`, ignoreSelection: true, stopEvent: () => true }));
    }
    return false;
  });
  return DecorationSet.create(doc, found);
}

/** The Inbox line under a DOM event's target, or null. */
function inboxLineAt(target: EventTarget | null, pills: InboxPills): string | null {
  const lineId = (target as HTMLElement | null)?.closest?.('[data-line-id]')?.getAttribute('data-line-id') ?? null;
  return lineId !== null && pills.lines.get().has(lineId) ? lineId : null;
}

export function inboxPillExtension(pills: InboxPills): AnyExtension {
  return Extension.create({
    name: 'inboxPills',
    addProseMirrorPlugins() {
      let press: { timer: ReturnType<typeof setTimeout>; x: number; y: number } | null = null;
      const cancel = () => {
        if (press) clearTimeout(press.timer);
        press = null;
        return false;
      };
      return [
        new Plugin<DecorationSet>({
          key,
          state: {
            init: (_, state) => decorations(state.doc, pills),
            // Content that arrives through Yjs (the first load included) can bring lines that have pills, so any change redraws.
            apply: (tr, held) => (tr.getMeta(key) || tr.docChanged ? decorations(tr.doc, pills) : held),
          },
          props: {
            decorations: (state) => key.getState(state),
            handleDOMEvents: {
              contextmenu: (_view, event) => {
                const lineId = inboxLineAt(event.target, pills);
                if (lineId === null) return false;
                event.preventDefault();
                cancel();
                pills.openMenu(lineId, event.clientX, event.clientY);
                return true;
              },
              pointerdown: (_view, event) => {
                cancel();
                const lineId = event.pointerType === 'mouse' ? null : inboxLineAt(event.target, pills);
                if (lineId === null) return false;
                const { clientX: x, clientY: y } = event;
                press = { x, y, timer: setTimeout(() => ((press = null), pills.openMenu(lineId, x, y)), LONG_PRESS_MS) };
                return false;
              },
              pointermove: (_view, event) => {
                if (press && Math.hypot(event.clientX - press.x, event.clientY - press.y) > MOVE_TOLERANCE_PX) cancel();
                return false;
              },
              pointerup: cancel,
              pointercancel: cancel,
            },
          },
          view: (view: EditorView) => {
            const redraw = () =>
              queueMicrotask(() => {
                if (!view.isDestroyed) view.dispatch(view.state.tr.setMeta(key, true).setMeta('addToHistory', false));
              });
            const stop = pills.lines.subscribe(redraw);
            return {
              destroy: () => {
                stop();
                cancel();
              },
            };
          },
        }),
      ];
    },
  });
}
