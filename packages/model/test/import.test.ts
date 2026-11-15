import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  LIBRARY_DOC_ID,
  exportZip,
  importTree,
  listNotebooks,
  notebookDocId,
  pageDocId,
  readPage,
  readTree,
  type ImportedBlock,
  type ImportedNotebook,
  type JSONContent,
  type PageJson,
  type SectionEntry,
  type TextContainer,
} from '../src/index.js';
import { MemoryReplica, PNG_BYTES, sha256 } from './helpers.js';

/** A one-page notebook whose text container holds these blocks. */
function notebookWith(blocks: ImportedBlock[]): ImportedNotebook {
  const text = { kind: 'text' as const, x: 0, y: 0, width: 300, blocks };
  const page = { title: 'P', level: 0 as const, containers: [text], strokes: [], warnings: [] };
  return { name: 'N', children: [{ kind: 'section', name: 'S', pages: [page] }] };
}

async function importedBody(replica: MemoryReplica, notebookId: string): Promise<JSONContent[]> {
  const section = readTree(replica.doc(notebookDocId(notebookId))).children[0] as SectionEntry;
  const page = readPage(replica.doc(pageDocId(section.pages[0]!.id)));
  return (page.containers[0] as TextContainer).body.content!;
}

const FILE_BYTES = new Uint8Array([37, 80, 68, 70]);

export const fixture: ImportedNotebook = {
  name: 'Field notes',
  color: '#2b9e90',
  children: [
    {
      kind: 'section',
      name: 'Garden',
      color: '#d0485a',
      pages: [
        {
          title: 'Planting notes',
          level: 0,
          createdAt: Date.UTC(2026, 2, 1, 9, 0),
          modifiedAt: Date.UTC(2026, 2, 2, 9, 0),
          warnings: ['an ink drawing used an unknown pen'],
          containers: [
            {
              kind: 'text',
              x: 40,
              y: 20,
              width: 480,
              blocks: [
                { type: 'paragraph', heading: 1, runs: [{ text: 'Spring beds' }] },
                {
                  type: 'paragraph',
                  align: 'center',
                  runs: [
                    { text: 'Bold ', bold: true },
                    { text: 'italic ', italic: true },
                    { text: 'under ', underline: true },
                    { text: 'struck ', strike: true },
                    { text: '2', subscript: true },
                    { text: 'n', superscript: true },
                    { text: ' lit', highlight: '#ffff00' },
                    { text: ' red', color: '#cc0000', fontFamily: 'Georgia', fontSize: 14 },
                    { text: ' link', link: 'https://example.org/seeds' },
                    { text: '\nsecond line' },
                  ],
                },
                { type: 'paragraph', tag: 'todo', checked: false, runs: [{ text: 'Order compost' }] },
                { type: 'paragraph', tag: 'todo', checked: true, runs: [{ text: 'Sharpen hoe' }] },
                { type: 'paragraph', tag: 'important', runs: [{ text: 'Frost after April 10' }] },
                { type: 'paragraph', tag: 'question', runs: [{ text: 'Raised beds?' }] },
                { type: 'paragraph', tag: 'remember', indent: 2, runs: [{ text: 'Buy twine' }] },
                { type: 'paragraph', tag: 'definition', runs: [{ text: 'Tilth: soil texture' }] },
                { type: 'paragraph', style: 'quote', runs: [{ text: 'To plant a garden is to believe in tomorrow.' }] },
                { type: 'paragraph', style: 'citation', runs: [{ text: 'Garden proverb' }] },
                { type: 'paragraph', style: 'code', runs: [{ text: 'rows = 4' }] },
                {
                  type: 'list',
                  ordered: false,
                  items: [
                    { blocks: [{ type: 'paragraph', runs: [{ text: 'Carrots' }] }] },
                    {
                      blocks: [
                        { type: 'paragraph', runs: [{ text: 'Beans' }] },
                        {
                          type: 'list',
                          ordered: true,
                          items: [
                            { blocks: [{ type: 'paragraph', runs: [{ text: 'Runner' }] }] },
                            { blocks: [{ type: 'paragraph', runs: [{ text: 'Broad' }] }] },
                          ],
                        },
                      ],
                    },
                    { blocks: [{ type: 'list', ordered: false, items: [{ blocks: [{ type: 'paragraph', runs: [{ text: 'Deep' }] }] }] }] },
                  ],
                },
                {
                  type: 'table',
                  columnWidths: [120, 200],
                  rows: [
                    [
                      { blocks: [{ type: 'paragraph', runs: [{ text: 'Bed' }] }], background: '#eeeeee' },
                      { blocks: [{ type: 'paragraph', runs: [{ text: 'Crop' }] }] },
                    ],
                    [
                      { blocks: [{ type: 'paragraph', runs: [{ text: 'North' }] }] },
                      { blocks: [] },
                    ],
                  ],
                },
                { type: 'image', data: PNG_BYTES, mime: 'image/png', width: 32, height: 32, alt: 'Seed packet' },
              ],
            },
            { kind: 'image', x: 600, y: 20, width: 200, height: 150, data: PNG_BYTES, mime: 'image/png', name: 'bed.png' },
            { kind: 'file', x: 600, y: 200, width: 160, data: FILE_BYTES, mime: 'application/pdf', name: 'seeds.pdf' },
          ],
          strokes: [
            { tool: 'pen', color: '#000000', width: 2, points: [10, 10, 50, 60, 90, 20] },
            { tool: 'highlighter', color: '#ffee00', width: 14, points: [1, 2, 3] },
          ],
        },
        { title: 'Watering', level: 1, containers: [], strokes: [], warnings: [] },
      ],
    },
    {
      kind: 'group',
      name: 'Archive',
      children: [{ kind: 'section', name: '2025', pages: [{ title: 'Old', level: 0, containers: [], strokes: [], warnings: [] }] }],
    },
  ],
};

describe('importTree', () => {
  it('creates the notebook, nodes and page docs', async () => {
    const replica = new MemoryReplica();
    const summary = await importTree(fixture, replica);
    expect(summary).toMatchObject({ groups: 1, sections: 2, pages: 3, containers: 3, strokes: 1, blobs: 3 });
    expect(summary.warnings).toEqual([
      'Garden / Planting notes: an ink drawing used an unknown pen',
      'Garden / Planting notes: a stroke with 3 coordinates was left out',
    ]);
    expect(listNotebooks(replica.doc(LIBRARY_DOC_ID))).toMatchObject([
      { id: summary.notebookId, name: 'Field notes', color: 'teal' },
    ]);

    const tree = readTree(replica.doc(notebookDocId(summary.notebookId)));
    const garden = tree.children[0] as SectionEntry;
    expect(garden).toMatchObject({ kind: 'section', name: 'Garden', color: 'red' });
    expect(garden.pages.map((p) => [p.title, p.level])).toEqual([
      ['Planting notes', 0],
      ['Watering', 1],
    ]);
    expect(garden.pages[0]!.createdAt).toBe(Date.UTC(2026, 2, 1, 9, 0));
    expect(tree.children[1]).toMatchObject({ kind: 'group', name: 'Archive', children: [{ name: '2025' }] });

    const page = readPage(replica.doc(pageDocId(garden.pages[0]!.id)));
    expect(page.containers.map((c) => c.kind)).toEqual(['text', 'image', 'file']);
    expect(page.containers[2]).toMatchObject({ blob: sha256(FILE_BYTES), name: 'seeds.pdf', size: 4 });
    expect(replica.blobs.get(sha256(PNG_BYTES))).toEqual(PNG_BYTES);

    const body = (page.containers[0] as TextContainer).body.content!;
    expect(body.map((b) => b.type)).toEqual([
      'heading',
      ...Array(10).fill('paragraph'),
      'bulletList',
      'table',
      'image',
    ]);
    const runs = body[1]!.content!;
    expect(body[1]!.attrs).toMatchObject({ textAlign: 'center' });
    expect(runs.find((r) => r.text === 'red')).toBeUndefined();
    expect(runs.find((r) => r.text === ' red')!.marks).toEqual([
      { type: 'textStyle', attrs: { color: '#cc0000', fontFamily: 'Georgia', fontSize: 14 } },
    ]);
    expect(runs.some((r) => r.type === 'hardBreak')).toBe(true);
    expect(body[3]!.attrs).toMatchObject({ tag: 'todo', checked: true });
    expect(body[6]!.attrs).toMatchObject({ tag: 'remember', indent: 2 });
    expect(body[5]!.attrs).toMatchObject({ indent: 0 });
    const deepItem = body[11]!.content![2]!;
    expect(deepItem.content!.map((b) => b.type)).toEqual(['paragraph', 'bulletList']);
    const firstCell = body[12]!.content![0]!.content![0]!;
    expect(firstCell.attrs).toMatchObject({ colwidth: [120], background: '#eeeeee' });
    expect(body[13]!.attrs).toEqual({ blob: sha256(PNG_BYTES), mime: 'image/png', width: 32, height: 32, alt: 'Seed packet' });
  });

  it('moves the partial notebook to Deleted notes when a blob cannot be stored', async () => {
    const replica = new MemoryReplica();
    replica.putBlob = async () => {
      throw new Error('disk full');
    };
    await expect(importTree(fixture, replica)).rejects.toThrow(/disk full.*partial notebook was moved to Deleted notes/);
    const library = replica.doc(LIBRARY_DOC_ID);
    expect(listNotebooks(library)).toEqual([]);
    expect(listNotebooks(library, { includeDeleted: true })).toMatchObject([{ name: 'Field notes' }]);
    expect(listNotebooks(library, { includeDeleted: true })[0]!.deletedAt).not.toBeNull();
  });

  it('moves the partial notebook to Deleted notes when a doc cannot be opened', async () => {
    const replica = new MemoryReplica();
    const getDoc = replica.getDoc.bind(replica);
    replica.getDoc = async (docId) => {
      if (docId.startsWith('pg:')) throw new Error('store closed');
      return getDoc(docId);
    };
    await expect(importTree(fixture, replica)).rejects.toThrow(/store closed.*Deleted notes/);
    expect(listNotebooks(replica.doc(LIBRARY_DOC_ID), { includeDeleted: true })[0]!.deletedAt).not.toBeNull();
  });

  it('keeps only links the exporters allow and turns the rest into plain text with a warning', async () => {
    const replica = new MemoryReplica();
    const hrefs = ['https://a.example', 'http://b.example', 'mailto:x@example.org', 'tel:+15551234', '#top'];
    const blocked = ['javascript:alert(1)', ' data:text/html,hi', 'vbscript:x', 'file:///etc/passwd'];
    const runs = [...hrefs, ...blocked].map((link, i) => ({ text: `r${i}`, link }));
    const summary = await importTree(notebookWith([{ type: 'paragraph', runs }]), replica);
    const nodes = (await importedBody(replica, summary.notebookId))[0]!.content!;
    // The dropped links' text keeps no mark, so it merges into one text node.
    expect(nodes.map((n) => [n.text, n.marks ?? null])).toEqual([
      ...hrefs.map((href, i) => [`r${i}`, [{ type: 'link', attrs: expect.objectContaining({ href }) }]]),
      ['r5r6r7r8', null],
    ]);
    expect(summary.warnings).toEqual(
      Array(blocked.length).fill('S / P: a link with an unsupported address was imported as plain text'),
    );
  });

  it('keeps a table cell background only when it is a #rgb or #rrggbb colour', async () => {
    const replica = new MemoryReplica();
    const backgrounds = ['#abc', '#A1B2C3', 'red', '#12345', 'url(x)', '#fff; position: fixed', undefined];
    const row = backgrounds.map((background) => ({ blocks: [], ...(background === undefined ? {} : { background }) }));
    const summary = await importTree(notebookWith([{ type: 'table', rows: [row] }]), replica);
    const cells = (await importedBody(replica, summary.notebookId))[0]!.content![0]!.content!;
    expect(cells.map((c) => c.attrs?.background)).toEqual(['#abc', '#A1B2C3', null, null, null, null, null]);
  });

  it('exports an imported notebook back to JSON and Markdown with its content', async () => {
    const replica = new MemoryReplica();
    const { notebookId } = await importTree(fixture, replica);
    const scope = { kind: 'notebook', notebookId } as const;

    const json = unzipSync(await exportZip(replica, scope, 'json'));
    const pageJson = JSON.parse(strFromU8(json['Field notes/Garden/Planting notes.json']!)) as PageJson;
    expect(pageJson).toMatchObject({ format: 'looseleaf-page', version: 1, title: 'Planting notes', level: 0 });
    expect(pageJson.containers).toHaveLength(3);
    expect(pageJson.strokes[0]!.points).toEqual([10, 10, 50, 60, 90, 20]);
    expect(json[`blobs/${sha256(PNG_BYTES)}`]).toEqual(PNG_BYTES);
    expect(json[`blobs/${sha256(FILE_BYTES)}`]).toEqual(FILE_BYTES);
    expect(Object.keys(json)).toContain('Field notes/Archive/2025/Old.json');

    const md = unzipSync(await exportZip(replica, scope, 'markdown'));
    const text = strFromU8(md['Field notes/Garden/Planting notes.md']!);
    expect(text).toContain('# Spring beds');
    expect(text).toContain('**Bold**');
    expect(text).toContain('*italic*');
    expect(text).toContain('~~struck~~');
    expect(text).toContain('[link](https://example.org/seeds)');
    expect(text).toContain('- [ ] Order compost');
    expect(text).toContain('- [x] Sharpen hoe');
    expect(text).toContain('[Important] Frost after April 10');
    expect(text).toContain('\n\n[Remember for later] Buy twine\n\n');
    expect(text).toContain('> To plant a garden');
    expect(text).toContain('```\nrows = 4\n```');
    expect(text).toContain('- Carrots\n- Beans\n  1. Runner\n  2. Broad');
    expect(text).toContain('| Bed | Crop |\n| --- | --- |\n| North |  |');
    expect(text).toContain(`![Seed packet](../../assets/${sha256(PNG_BYTES)}.png)`);
    expect(text).toContain(`[seeds.pdf](../../assets/${sha256(FILE_BYTES)}.pdf)`);
    expect(md[`assets/${sha256(PNG_BYTES)}.png`]).toEqual(PNG_BYTES);
  });
});
