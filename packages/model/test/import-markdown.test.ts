import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { pageToMarkdown } from '../src/export/markdown.js';
import {
  addImageContainer,
  addTextContainer,
  appendToPage,
  assertValidBody,
  markdownToBody,
  readPage,
  richTextSchema,
  textContainerBody,
  type JSONContent,
} from '../src/index.js';

/** The body's blocks as the schema normalizes them: attributes filled in, adjacent text with the same marks joined. */
async function blocksOf(markdown: string): Promise<JSONContent[]> {
  const { body } = await markdownToBody(markdown);
  assertValidBody(body);
  return (richTextSchema.nodeFromJSON(body).toJSON() as JSONContent).content!;
}

const text = (value: string, ...marks: string[]): JSONContent => ({
  type: 'text',
  text: value,
  ...(marks.length > 0 ? { marks: marks.map((type) => ({ type })) } : {}),
});

function paragraph(attrs: Record<string, unknown>, ...content: JSONContent[]): JSONContent {
  return { type: 'paragraph', attrs: expect.objectContaining(attrs), ...(content.length > 0 ? { content } : {}) };
}

/** The page as the Markdown export writes it, without the title and Created lines. */
function exported(body: JSONContent): string {
  const doc = new Y.Doc();
  addTextContainer(doc, { x: 0, y: 0, width: 300, body });
  const page = { id: 'p', title: 'T', level: 0 as const, createdAt: 0, modifiedAt: 0, snapshot: readPage(doc), blobs: new Map() };
  return pageToMarkdown(page, 'assets').markdown.split('\n\n').slice(2).join('\n\n');
}

describe('markdownToBody', () => {
  it('reads paragraphs, with a soft line break as a space and a hard one as a break', async () => {
    expect(await blocksOf('one\ntwo  \nthree\\\nfour <br> five\n\n\nsecond')).toEqual([
      paragraph({ tag: null, style: null }, text('one two'), { type: 'hardBreak' }, text('three'), { type: 'hardBreak' }, text('four '), { type: 'hardBreak' }, text(' five')),
      paragraph({}, text('second')),
    ]);
  });

  it('reads headings 1 to 6 and leaves a hash without a space as text', async () => {
    const blocks = await blocksOf('# One\n## Two ##\n### Three\n#### Four\n##### Five\n###### Six\n####### Seven\n#hashtag\n\\# escaped');
    expect(blocks.slice(0, 6).map((b) => [b.type, b.attrs!.level, b.content![0]!.text])).toEqual([
      ['heading', 1, 'One'],
      ['heading', 2, 'Two'],
      ['heading', 3, 'Three'],
      ['heading', 4, 'Four'],
      ['heading', 5, 'Five'],
      ['heading', 6, 'Six'],
    ]);
    expect(blocks.slice(6)).toEqual([paragraph({}, text('####### Seven #hashtag # escaped'))]);
  });

  it('reads bullet and ordered lists with nesting, including lists indented less than the text', async () => {
    const blocks = await blocksOf('- a\n- b\n  - b1\n    1. deep\n- c\n  continued\n\n1. x\n  - under x\n2. y');
    const item = (...content: JSONContent[]) => ({ type: 'listItem', content });
    expect(blocks).toEqual([
      {
        type: 'bulletList',
        content: [
          item(paragraph({}, text('a'))),
          item(
            paragraph({}, text('b')),
            { type: 'bulletList', content: [item(paragraph({}, text('b1')), { type: 'orderedList', attrs: expect.anything(), content: [item(paragraph({}, text('deep')))] })] },
          ),
          item(paragraph({}, text('c continued'))),
        ],
      },
      {
        type: 'orderedList',
        attrs: expect.anything(),
        content: [item(paragraph({}, text('x')), { type: 'bulletList', content: [item(paragraph({}, text('under x')))] }), item(paragraph({}, text('y')))],
      },
    ]);
  });

  it('reads task items as To Do paragraphs, splitting a list around them', async () => {
    const blocks = await blocksOf('- [ ] open\n- [x] done\n  - [X] nested done\n- plain\n- [ ] ## A heading task');
    expect(blocks).toEqual([
      paragraph({ tag: 'todo', checked: false }, text('open')),
      paragraph({ tag: 'todo', checked: true }, text('done')),
      paragraph({ tag: 'todo', checked: true, indent: 1 }, text('nested done')),
      { type: 'bulletList', content: [{ type: 'listItem', content: [paragraph({ tag: null }, text('plain'))] }] },
      { type: 'heading', attrs: expect.objectContaining({ level: 2, tag: 'todo', checked: false }), content: [text('A heading task')] },
    ]);
  });

  it('reads tag markers the export writes and leaves other brackets alone', async () => {
    expect(await blocksOf('[Important] Call back\n\n[Remember for later] ## Ideas\n\n[Someday] maybe')).toEqual([
      paragraph({ tag: 'important' }, text('Call back')),
      { type: 'heading', attrs: expect.objectContaining({ level: 2, tag: 'remember' }), content: [text('Ideas')] },
      paragraph({ tag: null }, text('[Someday] maybe')),
    ]);
  });

  it('reads bold, italic, both, strike and the HTML marks the export writes', async () => {
    const [first] = await blocksOf('**b** *i* __b2__ _i2_ ***bi*** ~~s~~ <u>u</u> <sub>2</sub> <sup>3</sup> <mark>m</mark> **a *nested* b**');
    const marks = (first!.content ?? []).filter((node) => node.text!.trim() !== '').map((node) => [node.text, (node.marks ?? []).map((m) => m.type)]);
    expect(marks).toEqual([
      ['b', ['bold']],
      ['i', ['italic']],
      ['b2', ['bold']],
      ['i2', ['italic']],
      ['bi', ['bold', 'italic']],
      ['s', ['strike']],
      ['u', ['underline']],
      ['2', ['subscript']],
      ['3', ['superscript']],
      [' m ', []],
      ['a ', ['bold']],
      ['nested', ['bold', 'italic']],
      [' b', ['bold']],
    ]);
  });

  it('keeps underscores inside words, unclosed delimiters and escapes as text', async () => {
    expect(await blocksOf('snake_case_name and 2*3 and **open and \\*not\\* and a_b_')).toEqual([
      paragraph({}, text('snake_case_name and 2*3 and **open and *not* and a_b_')),
    ]);
  });

  it('keeps inline code text without its backticks and without reading marks inside it', async () => {
    expect(await blocksOf('run `npm **test**` or `` a`b `` and `unclosed')).toEqual([
      paragraph({}, text('run npm **test** or a`b and `unclosed')),
    ]);
  });

  it('reads links and autolinks, and keeps an unsafe link as plain text with a warning', async () => {
    const markdown = '[the **site**](https://example.com/a_(b) "Title") <https://x.test/p_q_> [bad](javascript:alert(1)) ![pic](https://example.com/p.png)';
    const link = (href: string) => ({ type: 'link', attrs: expect.objectContaining({ href }) });
    expect(await blocksOf(markdown)).toEqual([
      paragraph(
        {},
        { type: 'text', text: 'the ', marks: [link('https://example.com/a_(b)')] },
        { type: 'text', text: 'site', marks: [link('https://example.com/a_(b)'), { type: 'bold' }] },
        text(' '),
        { type: 'text', text: 'https://x.test/p_q_', marks: [link('https://x.test/p_q_')] },
        text(' bad '),
        { type: 'text', text: 'pic', marks: [link('https://example.com/p.png')] },
      ),
    ]);
    expect((await markdownToBody(markdown)).warnings).toEqual(['a link with an unsupported address was imported as plain text']);
  });

  it('reads a fenced block as code paragraphs, keeping its text as written', async () => {
    expect(await blocksOf('before\n```ts\nconst a = **b**;\n\n  indented\n```\nafter\n~~~\nunclosed')).toEqual([
      paragraph({ style: null }, text('before')),
      paragraph({ style: 'code' }, text('const a = **b**;')),
      paragraph({ style: 'code' }),
      paragraph({ style: 'code' }, text('  indented')),
      paragraph({ style: null }, text('after')),
      paragraph({ style: 'code' }, text('unclosed')),
    ]);
  });

  it('reads block quotes as the quote style, with lazy continuation lines', async () => {
    expect(await blocksOf('> first\nlazy\n>\n> second\n\n> - [ ] quoted task\n\nout')).toEqual([
      paragraph({ style: 'quote' }, text('first lazy')),
      paragraph({ style: 'quote' }, text('second')),
      paragraph({ style: 'quote', tag: 'todo' }, text('quoted task')),
      paragraph({ style: null }, text('out')),
    ]);
  });

  it('reads a pipe table, padding short rows and unescaping pipes', async () => {
    const [table] = await blocksOf('| A | **B** |\n| --- | :-: |\n| 1 | a \\| b |\n| 2 |\nafter');
    const cells = (table!.content ?? []).map((row) => (row.content ?? []).map((cell) => (cell.content![0]!.content ?? []).map((n) => n.text).join('')));
    expect(table!.type).toBe('table');
    expect(cells).toEqual([
      ['A', 'B'],
      ['1', 'a | b'],
      ['2', ''],
    ]);
  });

  it('gives one empty paragraph for empty input and never throws on odd input', async () => {
    expect(await blocksOf('')).toEqual([{ type: 'paragraph', attrs: expect.anything() }]);
    expect(await blocksOf('```\n```')).toEqual([{ type: 'paragraph', attrs: expect.anything() }]);
    const pieces = ['*', '_', '~', '`', '[', ']', '(', ')', '<', '>', '#', '-', '|', '\\', '1.', ' ', '  ', '\n', '\t', 'x', '<br>', '[ ]', '<u>', '</u>', 'https://a.b'];
    let seed = 7;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31);
    for (let run = 0; run < 400; run++) {
      const input = Array.from({ length: 40 }, () => pieces[next() % pieces.length]).join('');
      await expect(blocksOf(input), JSON.stringify(input)).resolves.toBeDefined();
    }
  });

  it('reads back what the Markdown export writes, so a second export is the same', async () => {
    const original = `# Plan

Some **bold**, *italic*, ~~gone~~, <u>under</u> and a [link](https://example.com/x%20y).<br>Next line.

- [ ] open task

- [x] closed task

[Question] Why?

> A quote

\`\`\`
code **raw**
  kept
\`\`\`

- one
- two
  - two a
  1. ordered under

1. first
2. second

| H1 | H2 |
| --- | --- |
| a | b |

Plain \\* star and 1\\. not a list`;
    const once = exported((await markdownToBody(original)).body);
    const twice = exported((await markdownToBody(once)).body);
    expect(twice).toBe(once);
    expect(once).toContain('- [ ] open task');
    expect(once).toContain('```\ncode **raw**\n  kept\n```');
    expect(once).toContain('| a | b |');
  });
});

describe('appendToPage', () => {
  const body = (...lines: string[]): JSONContent => ({
    type: 'doc',
    content: lines.map((line) => ({ type: 'paragraph', content: [{ type: 'text', text: line }] })),
  });

  it('adds after the last text container in reading order and leaves existing nodes as they were', () => {
    const doc = new Y.Doc();
    const lower = addTextContainer(doc, { x: 0, y: 500, width: 300, body: body('lower one', 'lower two') });
    const upper = addTextContainer(doc, { x: 0, y: 10, width: 300, body: body('upper') });
    const fragment = textContainerBody(doc, lower);
    const before = fragment.toArray();
    const upperBefore = Y.encodeStateAsUpdate(doc);

    expect(appendToPage(doc, body('added'))).toBe(lower);

    const after = fragment.toArray();
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.slice(0, before.length).every((node, i) => node === before[i])).toBe(true);
    const containers = readPage(doc).containers;
    expect(containers.map((c) => (c.kind === 'text' ? c.body.content!.map((p) => p.content![0]!.text) : []))).toEqual([
      ['upper'],
      ['lower one', 'lower two', 'added'],
    ]);
    // Everything that was in the doc is still in it: the new state contains the old one.
    const merged = new Y.Doc();
    Y.applyUpdate(merged, Y.encodeStateAsUpdate(doc));
    Y.applyUpdate(merged, upperBefore);
    expect(Y.encodeStateAsUpdate(merged)).toEqual(Y.encodeStateAsUpdate(doc));
    expect(upper).not.toBe(lower);
  });

  it('adds a text container below the pictures on a page with no text, and at the top of an empty page', () => {
    const doc = new Y.Doc();
    addImageContainer(doc, { x: 300, y: 100, width: 50, height: 80, blob: 'a'.repeat(64), mime: 'image/png', name: 'p.png', size: 1 });
    const id = appendToPage(doc, body('below'));
    expect(readPage(doc).containers.at(-1)).toMatchObject({ id, kind: 'text', x: 48, y: 204, width: 400 });

    const empty = new Y.Doc();
    appendToPage(empty, body('first'));
    expect(readPage(empty).containers).toMatchObject([{ kind: 'text', x: 48, y: 24 }]);
  });

  it('refuses a body that does not fit the schema and changes nothing', () => {
    const doc = new Y.Doc();
    addTextContainer(doc, { x: 0, y: 0, width: 300, body: body('kept') });
    const state = Y.encodeStateAsUpdate(doc);
    expect(() => appendToPage(doc, { type: 'doc', content: [{ type: 'nope' }] })).toThrow('rich-text schema');
    expect(Y.encodeStateAsUpdate(doc)).toEqual(state);
  });
});
