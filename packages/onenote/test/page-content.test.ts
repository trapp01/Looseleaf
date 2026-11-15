import { describe, expect, it } from 'vitest';
import type { ImportedTextContainer } from '../../model/src/import-tree.js';
import { InkJcid, Jcid } from '../src/jcids.js';
import { halfInchesToPx, isNumberedListFormat, readColumnWidths, readPageContent } from '../src/page-content.js';
import { PropertyId as P } from '../src/property-ids.js';
import { data, f32, objectPool, props, refs, text } from './objects.js';

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0];
const BULLET_FORMAT = [1, 0, 0x22, 0x20]; // length 1, then U+2022
const NUMBER_FORMAT = [3, 0, 0xfd, 0xff, 0, 0, 0x2e, 0]; // length 3, U+FFFD, format 0, "."

type Pool = ReturnType<typeof objectPool>;

/** Adds an outline element holding one paragraph, optionally a list item, with child elements. */
function element(pool: Pool, id: string, words: string, options: { list?: number[]; kids?: string[] } = {}): string {
  pool.add(`${id}.text`, Jcid.RichTextOENode, [text(P.RichEditTextUnicode, words)]);
  const entries = [refs(P.ContentChildNodes, `${id}.text`)];
  if (options.list) {
    pool.add(`${id}.list`, Jcid.NumberListNode, [data(P.NumberListFormat, options.list)]);
    entries.push(refs(P.ListNodes, `${id}.list`));
  }
  if (options.kids) entries.push(refs(P.ElementChildNodes, ...options.kids));
  return pool.add(id, Jcid.OutlineElementNode, entries);
}

function page(pool: Pool, ...children: string[]) {
  pool.add('page', Jcid.PageNode, [refs(P.ElementChildNodes, ...children)]);
  return pool.ctx().object('page')!;
}

function outline(pool: Pool, id: string, elements: string[], x = 2, y = 3, width = 10): string {
  return pool.add(id, Jcid.OutlineNode, [
    refs(P.ElementChildNodes, ...elements),
    f32(P.OffsetFromParentHoriz, x),
    f32(P.OffsetFromParentVert, y),
    f32(P.LayoutMaxWidth, width),
  ]);
}

describe('units', () => {
  it('converts half-inch increments to CSS px at 48 px each', () => {
    expect(halfInchesToPx(1)).toBe(48);
    expect(halfInchesToPx(2.5)).toBe(120);
    expect(halfInchesToPx(0.4)).toBe(19.2);
  });

  it('reads TableColumnWidths in half-inches', () => {
    expect(readColumnWidths(Uint8Array.from([2, ...new Uint8Array(new Float32Array([1, 3]).buffer)]))).toEqual([48, 144]);
    expect(readColumnWidths(undefined)).toBeUndefined();
  });

  it('tells numbered list formats from bulleted ones by U+FFFD', () => {
    expect(isNumberedListFormat(Uint8Array.from(NUMBER_FORMAT))).toBe(true);
    expect(isNumberedListFormat(Uint8Array.from(BULLET_FORMAT))).toBe(false);
  });
});

describe('outlines', () => {
  it('places an outline as a text container in px', () => {
    const pool = objectPool();
    outline(pool, 'o', [element(pool, 'e1', 'Hello')]);
    const { containers } = readPageContent(page(pool, 'o'), pool.ctx());
    expect(containers).toEqual([
      { kind: 'text', x: 96, y: 64, width: 480, blocks: [{ type: 'paragraph', runs: [{ text: 'Hello' }] }] },
    ]);
  });

  it('merges consecutive list items, splits on a change of kind, and nests children inside items', () => {
    const pool = objectPool();
    const nested = element(pool, 'n1', 'nested', { list: NUMBER_FORMAT });
    outline(pool, 'o', [
      element(pool, 'b1', 'one', { list: BULLET_FORMAT, kids: [nested] }),
      element(pool, 'b2', 'two', { list: BULLET_FORMAT }),
      element(pool, 'p', 'plain'),
      element(pool, 'b3', 'three', { list: BULLET_FORMAT }),
      element(pool, 'n2', 'four', { list: NUMBER_FORMAT }),
    ]);
    const blocks = (readPageContent(page(pool, 'o'), pool.ctx()).containers[0] as ImportedTextContainer).blocks;
    const para = (t: string) => ({ type: 'paragraph', runs: [{ text: t }] });
    expect(blocks).toEqual([
      {
        type: 'list',
        ordered: false,
        items: [{ blocks: [para('one'), { type: 'list', ordered: true, items: [{ blocks: [para('nested')] }] }] }, { blocks: [para('two')] }],
      },
      para('plain'),
      { type: 'list', ordered: false, items: [{ blocks: [para('three')] }] },
      { type: 'list', ordered: true, items: [{ blocks: [para('four')] }] },
    ]);
  });

  it('indents children of plain paragraphs one step per level, outline groups included, without recursion', () => {
    const pool = objectPool();
    let child = element(pool, 'deep0', 'leaf');
    for (let i = 1; i < 20_000; i++) child = element(pool, `deep${i}`, 'x', { kids: [child] });
    pool.add('group', Jcid.OutlineGroup, [refs(P.ElementChildNodes, element(pool, 'grouped', 'g'))]);
    outline(pool, 'o', [child, 'group']);
    const blocks = (readPageContent(page(pool, 'o'), pool.ctx()).containers[0] as ImportedTextContainer).blocks;
    expect(blocks).toHaveLength(20_001);
    expect(blocks[0]).toEqual({ type: 'paragraph', runs: [{ text: 'x' }] });
    expect(blocks[1]).toMatchObject({ indent: 1 });
    expect(blocks[19_999]).toMatchObject({ indent: 19_999, runs: [{ text: 'leaf' }] });
    expect(blocks[20_000]).toMatchObject({ indent: 1, runs: [{ text: 'g' }] });
    expect(pool.warnings).toEqual([]);
  });

  it('starts indentation afresh inside a list item', () => {
    const pool = objectPool();
    const grandchild = element(pool, 'gc', 'deeper');
    const plainChild = element(pool, 'pc', 'continued', { kids: [grandchild] });
    outline(pool, 'o', [element(pool, 'li', 'item', { list: BULLET_FORMAT, kids: [plainChild] })]);
    const [list] = (readPageContent(page(pool, 'o'), pool.ctx()).containers[0] as ImportedTextContainer).blocks;
    expect(list).toMatchObject({
      type: 'list',
      items: [{ blocks: [{ runs: [{ text: 'item' }] }, { runs: [{ text: 'continued' }] }, { indent: 1, runs: [{ text: 'deeper' }] }] }],
    });
    expect((list as { items: Array<{ blocks: object[] }> }).items[0]!.blocks[1]).not.toHaveProperty('indent');
  });

  it('skips a reference cycle instead of looping', () => {
    const pool = objectPool();
    pool.add('loop.text', Jcid.RichTextOENode, [text(P.RichEditTextUnicode, 'again')]);
    pool.add('loop', Jcid.OutlineElementNode, [refs(P.ContentChildNodes, 'loop.text'), refs(P.ElementChildNodes, 'loop')]);
    outline(pool, 'o', ['loop']);
    const blocks = (readPageContent(page(pool, 'o'), pool.ctx()).containers[0] as ImportedTextContainer).blocks;
    expect(blocks).toHaveLength(1);
  });
});

describe('tables, pictures, files and ink', () => {
  it('reads a table with column widths, cell shading and cell content', () => {
    const pool = objectPool();
    const cell = (id: string, words: string, shading?: number[]) =>
      pool.add(id, Jcid.TableCellNode, [refs(P.ElementChildNodes, element(pool, `${id}.e`, words)), ...(shading ? [data(P.CellShadingColor, shading)] : [])]);
    pool.add('row', Jcid.TableRowNode, [refs(P.ElementChildNodes, cell('c1', 'a', [0xff, 0, 0, 0]), cell('c2', 'b'))]);
    pool.add('table', Jcid.TableNode, [refs(P.ElementChildNodes, 'row'), data(P.TableColumnWidths, [2, ...new Uint8Array(new Float32Array([2, 4]).buffer)])]);
    pool.add('te', Jcid.OutlineElementNode, [refs(P.ContentChildNodes, 'table')]);
    outline(pool, 'o', ['te']);
    const blocks = (readPageContent(page(pool, 'o'), pool.ctx()).containers[0] as ImportedTextContainer).blocks;
    expect(blocks).toEqual([
      {
        type: 'table',
        columnWidths: [96, 192],
        rows: [[{ blocks: [{ type: 'paragraph', runs: [{ text: 'a' }] }], background: '#ff0000' }, { blocks: [{ type: 'paragraph', runs: [{ text: 'b' }] }] }]],
      },
    ]);
  });

  it('reads inline and page-level pictures with sniffed media types and sizes', () => {
    const pool = objectPool();
    pool.add('pic', 0x00080039, [], { file: { kind: 'stored', data: Uint8Array.from(PNG), extension: '.jpg' } });
    pool.add('img', Jcid.ImageNode, [refs(P.PictureContainer, 'pic'), f32(P.PictureWidth, 4), f32(P.PictureHeight, 2), text(P.ImageAltText, 'alt')]);
    pool.add('ie', Jcid.OutlineElementNode, [refs(P.ContentChildNodes, 'img')]);
    outline(pool, 'o', ['ie']);
    pool.add('pageImg', Jcid.ImageNode, [refs(P.PictureContainer, 'pic'), f32(P.PictureWidth, 1), f32(P.OffsetFromParentHoriz, 1), f32(P.OffsetFromParentVert, 1)]);
    const { containers } = readPageContent(page(pool, 'o', 'pageImg'), pool.ctx());
    expect((containers[0] as ImportedTextContainer).blocks[0]).toMatchObject({ type: 'image', mime: 'image/png', width: 192, height: 96, alt: 'alt' });
    expect(containers[1]).toMatchObject({ kind: 'image', x: 48, y: 0, width: 48, mime: 'image/png' });
  });

  it('moves an attached file out of its outline, and warns about pictures without data', () => {
    const pool = objectPool();
    pool.add('blob', 0x00080036, [], { file: { kind: 'stored', data: Uint8Array.from([1, 2, 3]), extension: '.pdf' } });
    pool.add('emb', Jcid.EmbeddedFileNode, [refs(P.EmbeddedFileContainer, 'blob'), text(P.EmbeddedFileName, 'report.pdf')]);
    pool.add('fe', Jcid.OutlineElementNode, [refs(P.ContentChildNodes, 'emb')]);
    pool.add('missing', 0x00080039, [], { file: { kind: 'external', extension: '.png' } });
    pool.add('img', Jcid.ImageNode, [refs(P.PictureContainer, 'missing')]);
    pool.add('me', Jcid.OutlineElementNode, [refs(P.ContentChildNodes, 'img')]);
    outline(pool, 'o', ['fe', 'me']);
    const { containers } = readPageContent(page(pool, 'o'), pool.ctx());
    expect(containers).toEqual([{ kind: 'file', x: 96, y: 64, width: 48, data: Uint8Array.from([1, 2, 3]), mime: 'application/pdf', name: 'report.pdf' }]);
    expect(pool.warnings).toEqual(['Picture not imported: its data is kept outside the section file', 'Attached file moved out of its note container']);
  });

  it('counts ink strokes and warns about content of unknown kinds', () => {
    const pool = objectPool();
    pool.add('s1', InkJcid.InkStroke);
    pool.add('s2', InkJcid.InkStroke);
    pool.add('inkData', 0x0002003b, [refs(0x24003416, 's1', 's2')]);
    pool.add('ink', InkJcid.InkContainer, [refs(0x20003415, 'inkData')]);
    pool.add('odd', 0x00060099);
    const content = readPageContent(page(pool, 'ink', 'odd'), pool.ctx());
    expect(content.inkStrokes).toBe(2);
    expect(pool.warnings).toEqual(['Content of an unknown kind not imported']);
  });

  it('maps a to-do tag and its checked state', () => {
    const pool = objectPool();
    pool.add('t', Jcid.RichTextOENode, [
      text(P.RichEditTextUnicode, 'task'),
      [P.NoteTagStates, { kind: 'sets', value: [props([data(P.NoteTagShape, [1, 0]), data(P.ActionItemStatus, [1, 0])])] }],
    ]);
    pool.add('e', Jcid.OutlineElementNode, [refs(P.ContentChildNodes, 't')]);
    outline(pool, 'o', ['e']);
    const blocks = (readPageContent(page(pool, 'o'), pool.ctx()).containers[0] as ImportedTextContainer).blocks;
    expect(blocks[0]).toMatchObject({ type: 'paragraph', tag: 'todo', checked: true });
  });
});
