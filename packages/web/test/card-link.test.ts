// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { Editor } from '@tiptap/core';
import * as Y from 'yjs';
import { addTextContainer, textContainerBody } from '@looseleaf/model';
import { Store } from '../src/app/store.js';
import type { CardLinkInfo } from '../src/board/card-link-view.js';
import { textEditorExtensions, type TextEditorEnv } from '../src/canvas/text-editor.js';

function editorWith(content: unknown[], env: Partial<TextEditorEnv>) {
  const doc = new Y.Doc();
  const id = addTextContainer(doc, { x: 0, y: 0, width: 300, body: { type: 'doc', content: content as never } });
  const base = { blobs: { subscribe: () => () => undefined }, commands: {}, putBlob: async () => '', addFiles: () => undefined, inbox: null };
  return new Editor({ element: document.createElement('div'), extensions: textEditorExtensions(textContainerBody(doc, id), { ...base, ...env } as unknown as TextEditorEnv) });
}

/** A card link source whose card can be changed, notifying its listeners. */
function source(first: CardLinkInfo) {
  let info = first;
  const listeners = new Set<() => void>();
  return {
    read: () => info,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    open: vi.fn(),
    change(next: Partial<CardLinkInfo>) {
      info = { ...info, ...next };
      listeners.forEach((listener) => listener());
    },
  };
}

describe('a card link in the editor', () => {
  it('shows the card’s ref, title and status, follows changes, and opens its page on click, with nothing else lost', () => {
    const cards = source({ title: 'Order seeds', ref: 'HOME-3', status: 'In progress', kind: 'doing', archived: false });
    const editor = editorWith(
      [{ type: 'paragraph', content: [{ type: 'text', text: 'See ' }, { type: 'cardLink', attrs: { pageId: 'page-1' } }, { type: 'text', text: ' first' }] }],
      { cardLinks: cards },
    );
    const link = editor.view.dom.querySelector<HTMLElement>('span[data-card-link="page-1"]')!;
    expect(link.textContent).toBe('HOME-3Order seedsIn progress');
    cards.change({ title: 'Order seeds and bulbs', status: 'Done', kind: 'done' });
    expect(link.querySelector('.card-link-title')?.textContent).toBe('Order seeds and bulbs');
    expect(link.querySelector('.card-link-status')?.textContent).toBe('Done');
    cards.change({ status: null, kind: null, archived: true });
    expect(link.querySelector('.card-link-status')?.textContent).toBe('archived');
    link.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
    expect(cards.open).toHaveBeenCalledWith('page-1');
    expect(editor.getText()).toContain('See');
    expect(editor.getText()).toContain('first');
    // Copying writes the link as the schema's span, which pastes back as a card link.
    expect(editor.getHTML()).toContain('<span data-card-link="page-1"></span>');
    editor.destroy();
  });
});

describe('the Inbox pill', () => {
  it('ends each line in the Inbox and opens the line’s menu', async () => {
    const cards = source({ title: '', ref: null, status: null, kind: null, archived: false });
    const lines = new Store<ReadonlySet<string>>(new Set(['line-a']));
    const openMenu = vi.fn();
    const todo = (lineId: string, text: string) => ({ type: 'paragraph', attrs: { tag: 'todo', lineId, taggedAt: 5 }, content: [{ type: 'text', text }] });
    const editor = editorWith([todo('line-a', 'Prune the roses'), todo('line-b', 'Mend the fence')], { cardLinks: cards, inbox: { lines, openMenu } });
    const pillOn = (lineId: string) => editor.view.dom.querySelector(`[data-line-id="${lineId}"] .inbox-pill`);
    expect(pillOn('line-a')?.textContent).toBe('Inbox');
    expect(pillOn('line-b')).toBeNull();
    (pillOn('line-a') as HTMLElement).click();
    expect(openMenu).toHaveBeenCalledWith('line-a', expect.any(Number), expect.any(Number));
    // Right-click on the line opens the same menu.
    editor.view.dom.querySelector('[data-line-id="line-a"]')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 4, clientY: 6 }));
    expect(openMenu).toHaveBeenLastCalledWith('line-a', 4, 6);
    lines.set(new Set(['line-b']));
    await vi.waitFor(() => expect(pillOn('line-b')).not.toBeNull());
    expect(pillOn('line-a')).toBeNull();
    expect(editor.getText()).toBe('Prune the roses\n\nMend the fence');
    editor.destroy();
  });
});
