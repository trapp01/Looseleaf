import { describe, expect, it } from 'vitest';
import { AllSelection, EditorState, TextSelection } from '@tiptap/pm/state';
import * as Y from 'yjs';
import {
  INDENT_STEP_PX,
  assertValidBody,
  changeIndent,
  bodyToText,
  emptyBody,
  readBody,
  richTextExtensions,
  richTextSchema,
  writeBody,
  type JSONContent,
} from '../src/index.js';

function fragmentIn(doc = new Y.Doc()): Y.XmlFragment {
  const fragment = new Y.XmlFragment();
  doc.getMap('test').set('body', fragment);
  return fragment;
}

const rich: JSONContent = {
  type: 'doc',
  content: [
    {
      type: 'heading',
      attrs: { level: 2, tag: 'important', textAlign: 'center' },
      content: [{ type: 'text', text: 'Title' }],
    },
    {
      type: 'paragraph',
      attrs: { tag: 'todo', checked: true, style: 'quote' },
      content: [
        {
          type: 'text',
          text: 'styled',
          marks: [
            { type: 'bold' },
            { type: 'italic' },
            { type: 'underline' },
            { type: 'strike' },
            { type: 'superscript' },
            { type: 'highlight', attrs: { color: '#ffff00' } },
            { type: 'textStyle', attrs: { color: '#ff0000', fontFamily: 'Georgia', fontSize: 14 } },
            { type: 'link', attrs: { href: 'https://example.com' } },
          ],
        },
        { type: 'hardBreak' },
        { type: 'text', text: 'H', marks: [{ type: 'subscript' }] },
      ],
    },
    {
      type: 'bulletList',
      content: [
        {
          type: 'listItem',
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'one' }] },
            {
              type: 'orderedList',
              content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'nested' }] }] }],
            },
          ],
        },
      ],
    },
    {
      type: 'table',
      content: [
        {
          type: 'tableRow',
          content: [
            { type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A' }] }] },
            {
              type: 'tableCell',
              attrs: { background: '#eeeeee', colwidth: [120] },
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'B' }] }],
            },
          ],
        },
      ],
    },
    { type: 'image', attrs: { blob: 'ab'.repeat(32), mime: 'image/png', width: 10, height: 20, alt: 'dot' } },
  ],
};

describe('rich-text schema', () => {
  it('has exactly the nodes and marks the architecture lists', () => {
    expect(Object.keys(richTextSchema.nodes).sort()).toEqual(
      [
        'doc',
        'text',
        'paragraph',
        'heading',
        'bulletList',
        'orderedList',
        'listItem',
        'table',
        'tableRow',
        'tableCell',
        'tableHeader',
        'image',
        'hardBreak',
        'cardLink',
      ].sort(),
    );
    expect(Object.keys(richTextSchema.marks).sort()).toEqual(
      ['bold', 'italic', 'underline', 'strike', 'subscript', 'superscript', 'highlight', 'textStyle', 'link'].sort(),
    );
  });

  it('puts tag, checked, style, alignment and the To Do line fields on paragraphs and headings', () => {
    for (const name of ['paragraph', 'heading']) {
      const attrs = richTextSchema.nodes[name]!.spec.attrs!;
      expect(Object.keys(attrs)).toEqual(expect.arrayContaining(['tag', 'checked', 'style', 'textAlign', 'lineId', 'taggedAt', 'inbox']));
    }
    expect(Object.keys(richTextSchema.nodes.cardLink!.spec.attrs!)).toEqual(['pageId']);
    expect(Object.keys(richTextSchema.nodes.image!.spec.attrs!).sort()).toEqual(['alt', 'blob', 'height', 'mime', 'width']);
  });

  it('leaves history out of the extension list', () => {
    expect(richTextExtensions.map((e) => e.name)).not.toContain('history');
    const starter = richTextExtensions[0]!;
    expect((starter.options as Record<string, unknown>).history).toBe(false);
  });

  it('round-trips every node, mark and attribute through a Y.XmlFragment', () => {
    const fragment = fragmentIn();
    writeBody(fragment, rich);
    const back = readBody(fragment);
    expect(back).toEqual(readBody(fragmentFrom(back)));
    const heading = back.content![0]!;
    expect(heading.attrs).toMatchObject({ level: 2, tag: 'important', textAlign: 'center', checked: false, style: null });
    const para = back.content![1]!;
    expect(para.attrs).toMatchObject({ tag: 'todo', checked: true, style: 'quote' });
    const marks = para.content![0]!.marks!.map((m) => m.type).sort();
    expect(marks).toEqual(['bold', 'highlight', 'italic', 'link', 'strike', 'superscript', 'textStyle', 'underline']);
    const style = para.content![0]!.marks!.find((m) => m.type === 'textStyle')!;
    expect(style.attrs).toEqual({ color: '#ff0000', fontFamily: 'Georgia', fontSize: 14 });
    expect(back.content![3]!.content![0]!.content![1]!.attrs).toMatchObject({ background: '#eeeeee', colwidth: [120] });
    expect(back.content![4]!.attrs).toEqual({ blob: 'ab'.repeat(32), mime: 'image/png', width: 10, height: 20, alt: 'dot' });
  });

  it('rejects content outside the schema with a descriptive error', () => {
    expect(() => assertValidBody({ type: 'doc', content: [{ type: 'blockquote' }] })).toThrow(/rich-text schema/);
    expect(() => assertValidBody({ type: 'paragraph' })).toThrow(/not "doc"/);
    expect(() => writeBody(new Y.XmlFragment(), emptyBody())).toThrow(/part of a Y.Doc/);
  });

  it('reads a body without changing the doc', () => {
    const doc = new Y.Doc();
    const fragment = fragmentIn(doc);
    writeBody(fragment, rich);
    const before = Y.encodeStateAsUpdate(doc);
    readBody(fragment);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it('turns a body into plain text', () => {
    expect(bodyToText(rich)).toBe('Title\nstyled\nH\n- one\n  1. nested\nA\tB\n[Picture: dot]');
    expect(bodyToText(rich, { tags: true }).split('\n').slice(0, 2)).toEqual(['[Important] Title', '[x] styled']);
  });
});

describe('paragraph indent', () => {
  const doc = richTextSchema.nodeFromJSON({
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'body' }] },
      { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'head' }] },
      {
        type: 'bulletList',
        content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'item' }] }] }],
      },
    ],
  });
  const indents = (state: EditorState) => {
    const found: Array<[string, number]> = [];
    state.doc.descendants((n) => {
      if (n.type.name === 'paragraph' || n.type.name === 'heading') found.push([n.textContent, n.attrs.indent]);
    });
    return found;
  };

  it('defaults to 0 and survives a Y.XmlFragment round trip', () => {
    expect(richTextSchema.nodes.paragraph!.spec.attrs!.indent).toEqual({ default: 0 });
    const fragment = fragmentIn();
    writeBody(fragment, { type: 'doc', content: [{ type: 'paragraph', attrs: { indent: 3 } }] });
    expect(readBody(fragment).content![0]!.attrs!.indent).toBe(3);
    expect(INDENT_STEP_PX).toBe(36);
  });

  it('indents and outdents paragraphs and headings outside lists', () => {
    let state = EditorState.create({ doc });
    state = state.apply(state.tr.setSelection(new AllSelection(state.doc)));
    const tr = state.tr;
    expect(changeIndent(tr, 1)).toBe(true);
    expect(changeIndent(tr, 1)).toBe(true);
    state = state.apply(tr);
    expect(indents(state)).toEqual([
      ['body', 2],
      ['head', 2],
      ['item', 0],
    ]);
    const out = state.tr;
    expect(changeIndent(out, -5)).toBe(true);
    expect(changeIndent(out, -1)).toBe(false);
    expect(indents(state.apply(out)).map(([, n]) => n)).toEqual([0, 0, 0]);
  });

  it('leaves a selection inside a list item to the list', () => {
    const state = EditorState.create({ doc });
    const inItem = state.doc.content.size - 4;
    const tr = state.tr.setSelection(TextSelection.create(state.doc, inItem));
    expect(changeIndent(tr, 1)).toBe(false);
  });

  it('shows indent in plain text only when asked', () => {
    const body = { type: 'doc', content: [{ type: 'paragraph', attrs: { indent: 2 }, content: [{ type: 'text', text: 'x' }] }] };
    expect(bodyToText(body)).toBe('x');
    expect(bodyToText(body, { indent: true })).toBe('    x');
  });
});

function fragmentFrom(json: JSONContent): Y.XmlFragment {
  const fragment = fragmentIn();
  writeBody(fragment, json);
  return fragment;
}
