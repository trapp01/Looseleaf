import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { pageToHtml } from '../src/export/html.js';
import { pageToMarkdown } from '../src/export/markdown.js';
import { pageToText } from '../src/export/text.js';
import { safeHref } from '../src/rich-text.js';
import {
  addTextContainer,
  appendTodoLine,
  inboxLines,
  keepAsLine,
  listTodoLines,
  markdownToBody,
  readPage,
  removeDuplicateCardLinks,
  setTodoLineChecked,
  turnLineIntoCardLink,
  type JSONContent,
} from '../src/index.js';
import { fixedStamp, forkDoc, stateBytes, syncDocs } from './helpers.js';

const todo = (text: string, attrs: Record<string, unknown> = {}): JSONContent => ({
  type: 'paragraph',
  attrs: { tag: 'todo', ...attrs },
  content: [{ type: 'text', text }],
});

/** A page with a container lower down holding a list, and one higher up, so reading order differs from insertion order. */
function samplePage(): Y.Doc {
  const doc = new Y.Doc();
  addTextContainer(doc, {
    x: 0,
    y: 300,
    width: 300,
    body: {
      type: 'doc',
      content: [
        { type: 'bulletList', content: [{ type: 'listItem', content: [todo('Rake leaves', { lineId: 'b', taggedAt: 20, checked: true })] }] },
        todo('Imported line'),
      ],
    },
  });
  addTextContainer(doc, {
    x: 0,
    y: 0,
    width: 300,
    body: { type: 'doc', content: [todo('Buy seeds', { lineId: 'a', taggedAt: 10 }), { type: 'paragraph', content: [{ type: 'text', text: 'not a line' }] }] },
  });
  return doc;
}

function pageForExport(doc: Y.Doc, pageTitles?: Map<string, string>) {
  return { id: 'p', title: 'T', level: 0 as const, createdAt: 0, modifiedAt: 0, snapshot: readPage(doc), blobs: new Map(), pageTitles };
}

describe('To Do lines', () => {
  it('lists a page’s lines in reading order, with no id for an imported line', () => {
    expect(listTodoLines(samplePage())).toEqual([
      { id: 'a', text: 'Buy seeds', checked: false, taggedAt: 10, inbox: true },
      { id: 'b', text: 'Rake leaves', checked: true, taggedAt: 20, inbox: true },
      { id: null, text: 'Imported line', checked: false, taggedAt: null, inbox: true },
    ]);
  });

  it('ticks a line, keeps one out of the Inbox, and says when there is no such line', () => {
    const doc = samplePage();
    expect(setTodoLineChecked(doc, 'a', true)).toBe(true);
    expect(keepAsLine(doc, 'b')).toBe(true);
    expect(setTodoLineChecked(doc, 'missing', true)).toBe(false);
    expect(listTodoLines(doc).map((line) => [line.id, line.checked, line.inbox])).toEqual([
      ['a', true, true],
      ['b', true, false],
      [null, false, true],
    ]);
  });

  it('appends a new line with an id and a tagged-at time', () => {
    const doc = samplePage();
    expect(appendTodoLine(doc, '  Water the beds ', fixedStamp())).toBe('line-1');
    expect(listTodoLines(doc).at(-1)).toEqual({ id: 'line-1', text: 'Water the beds', checked: false, taggedAt: 1000, inbox: true });
  });

  it('keeps line fields and card links through Yjs', async () => {
    const doc = new Y.Doc();
    const { body } = await markdownToBody('- [ ] Fix the tap', { stamp: fixedStamp() });
    body.content!.push({ type: 'paragraph', content: [{ type: 'text', text: 'See ' }, { type: 'cardLink', attrs: { pageId: 'card-1' } }] });
    addTextContainer(doc, { x: 0, y: 0, width: 300, body });
    const read = readPage(doc).containers[0]!;
    expect(read.kind === 'text' && read.body.content!.map((block) => [block.attrs!.lineId, block.attrs!.taggedAt, block.content?.at(-1)])).toEqual([
      ['line-1', 1000, { type: 'text', text: 'Fix the tap' }],
      [null, null, { type: 'cardLink', attrs: { pageId: 'card-1' } }],
    ]);
  });
});

describe('turning a line into a card link', () => {
  it('replaces the line’s text with a link and clears everything that made it a To Do line, once', () => {
    const doc = samplePage();
    keepAsLine(doc, 'a');
    setTodoLineChecked(doc, 'a', true);
    expect(turnLineIntoCardLink(doc, 'a', 'a')).toBe(true);
    expect(turnLineIntoCardLink(doc, 'a', 'a')).toBe(false);
    expect(turnLineIntoCardLink(doc, 'nope', 'nope')).toBe(false);
    expect(listTodoLines(doc).map((line) => line.id)).toEqual(['b', null]);
    const first = readPage(doc).containers[0]!;
    expect(first.kind === 'text' && first.body.content![0]).toMatchObject({
      attrs: { tag: null, checked: false, lineId: null, taggedAt: null, inbox: true },
      content: [{ type: 'cardLink', attrs: { pageId: 'a' } }],
    });
  });

  it('never lists a line holding only card links, even tagged To Do', () => {
    const doc = new Y.Doc();
    const link = { type: 'cardLink', attrs: { pageId: 'card-1' } };
    addTextContainer(doc, {
      x: 0,
      y: 0,
      width: 300,
      body: { type: 'doc', content: [{ type: 'paragraph', attrs: { tag: 'todo', lineId: 'x', taggedAt: 300 }, content: [link] }, { type: 'paragraph', attrs: { tag: 'todo', lineId: 'y', taggedAt: 300 }, content: [{ type: 'text', text: 'See ' }, link] }] },
    });
    expect(listTodoLines(doc).map((line) => line.id)).toEqual(['y']);
    expect(setTodoLineChecked(doc, 'x', true)).toBe(false);
    expect(keepAsLine(doc, 'x')).toBe(false);
  });

  it('two replicas that turn the same line apart end with one link once duplicates are removed', () => {
    const a = samplePage();
    const b = forkDoc(a);
    turnLineIntoCardLink(a, 'a', 'a');
    turnLineIntoCardLink(b, 'a', 'a');
    syncDocs(a, b);
    expect(stateBytes(a)).toEqual(stateBytes(b));
    expect(removeDuplicateCardLinks(a)).toBe(1);
    expect(removeDuplicateCardLinks(b)).toBe(1);
    syncDocs(a, b);
    expect(stateBytes(a)).toEqual(stateBytes(b));
    expect(removeDuplicateCardLinks(a)).toBe(0);
    const first = readPage(a).containers[0]!;
    expect(first.kind === 'text' && first.body.content![0]!.content).toEqual([{ type: 'cardLink', attrs: { pageId: 'a' } }]);
  });
});

describe('card links in exports', () => {
  function pageWithLink(): Y.Doc {
    const doc = new Y.Doc();
    addTextContainer(doc, {
      x: 0,
      y: 0,
      width: 300,
      body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Next: ' }, { type: 'cardLink', attrs: { pageId: 'card-1' } }] }] },
    });
    return doc;
  }

  it('writes a link to the page address with the page title where the export has it', () => {
    const titles = new Map([['card-1', 'Replace the [old] tap']]);
    expect(pageToMarkdown(pageForExport(pageWithLink(), titles), 'assets').markdown).toContain('Next: [Replace the \\[old\\] tap](looseleaf://page/card-1)');
    expect(pageToMarkdown(pageForExport(pageWithLink()), 'assets').markdown).toContain('Next: [Linked card](looseleaf://page/card-1)');
    expect(pageToHtml(pageForExport(pageWithLink(), titles))).toContain('Next: <a class="card-link" href="looseleaf://page/card-1">Replace the [old] tap</a>');
    expect(pageToText(pageForExport(pageWithLink(), titles))).toContain('Next: Replace the [old] tap');
  });

  it('keeps a page address as a link when Markdown is read back', async () => {
    expect(safeHref(' looseleaf://page/card-1 ')).toBe('looseleaf://page/card-1');
    const { body, warnings } = await markdownToBody('[Tap](looseleaf://page/card-1)');
    expect(warnings).toEqual([]);
    expect(body.content![0]!.content![0]!.marks).toEqual([{ type: 'link', attrs: { href: 'looseleaf://page/card-1' } }]);
  });
});

describe('the Inbox', () => {
  const line = (id: string, taggedAt: number | null, more: Partial<{ checked: boolean; inbox: boolean }> = {}) => ({
    id,
    text: `line ${id}`,
    checked: more.checked ?? false,
    taggedAt,
    inbox: more.inbox ?? true,
  });

  it('holds unticked lines tagged after the board was made, on live pages that are not cards, newest first', () => {
    const result = inboxLines({
      createdAt: 100,
      lines: new Map([
        ['loose', [line('new', 300), line('newer', 400), line('before-board', 50), line('ticked', 300, { checked: true }), line('kept', 300, { inbox: false }), { ...line('imported', null), id: null }]],
        ['card', [line('on-card', 500)]],
        ['deleted', [line('on-deleted', 500)]],
      ]),
      cardPageIds: new Set(['card']),
      livePages: new Map([
        ['loose', { title: 'Scratch' }],
        ['card', { title: 'A card' }],
      ]),
    });
    expect(result).toEqual([
      { id: 'newer', text: 'line newer', taggedAt: 400, pageId: 'loose', pageTitle: 'Scratch' },
      { id: 'new', text: 'line new', taggedAt: 300, pageId: 'loose', pageTitle: 'Scratch' },
    ]);
  });
});
