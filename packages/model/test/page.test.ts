import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  addFileContainer,
  addImageContainer,
  addStroke,
  addTextContainer,
  deleteContainer,
  deleteStroke,
  extractPageText,
  moveContainer,
  readPage,
  readPageMeta,
  resizeContainer,
  restackContainer,
  setPaperColor,
  setPaperStyle,
  textContainerBody,
  type PaperStyle,
} from '../src/index.js';

const para = (text: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
const blob = { blob: 'f'.repeat(64), mime: 'image/png', name: 'dot.png', size: 68 };

const stackOrder = (doc: Y.Doc) =>
  readPage(doc)
    .containers.sort((a, b) => a.z - b.z)
    .map((c) => c.id);

describe('page doc', () => {
  it('reads an empty doc as an empty page', () => {
    const doc = new Y.Doc();
    expect(readPage(doc)).toEqual({ meta: { paperStyle: 'none', paperColor: null }, containers: [], strokes: [] });
    expect(extractPageText(doc)).toBe('');
  });

  it('sets paper style and colour', () => {
    const doc = new Y.Doc();
    setPaperStyle(doc, 'grid-small');
    setPaperColor(doc, '#fdf6e3');
    expect(readPageMeta(doc)).toEqual({ paperStyle: 'grid-small', paperColor: '#fdf6e3' });
    setPaperColor(doc, null);
    expect(readPageMeta(doc).paperColor).toBeNull();
    expect(() => setPaperStyle(doc, 'dots' as PaperStyle)).toThrow(/dots/);
  });

  it('adds text, image and file containers with the stored layout', () => {
    const doc = new Y.Doc();
    const t = addTextContainer(doc, { x: 10, y: 20, width: 300 });
    const i = addImageContainer(doc, { x: 0, y: 100, width: 50, height: 40, ...blob });
    const f = addFileContainer(doc, { x: 200, y: 100, width: 120, ...blob, mime: 'application/pdf', name: 'a.pdf' });
    const raw = (id: string) => (doc.getMap('containers').get(id) as Y.Map<unknown>);
    expect(raw(t).get('body')).toBeInstanceOf(Y.XmlFragment);
    expect(raw(i).toJSON()).toEqual({ kind: 'image', x: 0, y: 100, width: 50, height: 40, z: 1, ...blob });
    expect(raw(f).get('height')).toBeUndefined();
    const page = readPage(doc);
    expect(page.containers.map((c) => c.id)).toEqual([t, i, f]);
    expect(page.containers[0]).toMatchObject({ kind: 'text', body: { type: 'doc', content: [{ type: 'paragraph' }] } });
    expect(page.containers.map((c) => c.z)).toEqual([0, 1, 2]);
  });

  it('creates a text container from a given body and exposes the live fragment', () => {
    const doc = new Y.Doc();
    const t = addTextContainer(doc, { x: 0, y: 0, width: 100, body: para('hello') });
    expect(textContainerBody(doc, t).toString()).toContain('hello');
    expect(() => addTextContainer(doc, { x: 0, y: 0, width: 100, body: { type: 'doc', content: [{ type: 'nope' }] } })).toThrow(
      /rich-text schema/,
    );
    expect(readPage(doc).containers).toHaveLength(1);
  });

  it('moves, resizes and deletes containers', () => {
    const doc = new Y.Doc();
    const t = addTextContainer(doc, { x: 0, y: 0, width: 100 });
    const i = addImageContainer(doc, { x: 0, y: 0, width: 50, height: 50, ...blob });
    moveContainer(doc, t, { x: 40, y: 60 });
    resizeContainer(doc, t, { width: 250 });
    resizeContainer(doc, i, { width: 80, height: 90 });
    const [image, text] = readPage(doc).containers;
    expect(text).toMatchObject({ id: t, x: 40, y: 60, width: 250 });
    expect(image).toMatchObject({ id: i, width: 80, height: 90 });
    expect(() => resizeContainer(doc, t, { width: 1, height: 2 })).toThrow(/only pictures/);
    expect(() => moveContainer(doc, 'gone', { x: 0, y: 0 })).toThrow(/gone/);
    expect(() => moveContainer(doc, t, { x: NaN, y: 0 })).toThrow(/finite/);
    deleteContainer(doc, t);
    deleteContainer(doc, t);
    expect(readPage(doc).containers.map((c) => c.id)).toEqual([i]);
  });

  it('restacks containers', () => {
    const doc = new Y.Doc();
    const [a, b, c] = [0, 1, 2].map(() => addTextContainer(doc, { x: 0, y: 0, width: 10 })) as [string, string, string];
    restackContainer(doc, a, 'front');
    expect(stackOrder(doc)).toEqual([b, c, a]);
    restackContainer(doc, a, 'backward');
    expect(stackOrder(doc)).toEqual([b, a, c]);
    restackContainer(doc, b, 'forward');
    expect(stackOrder(doc)).toEqual([a, b, c]);
    restackContainer(doc, c, 'back');
    expect(stackOrder(doc)).toEqual([c, a, b]);
    restackContainer(doc, c, 'back');
    restackContainer(doc, b, 'forward');
    expect(stackOrder(doc)).toEqual([c, a, b]);
  });

  it('adds and erases strokes', () => {
    const doc = new Y.Doc();
    const s = addStroke(doc, { tool: 'pen', color: '#000000', width: 2, points: [0, 0, 10, 10] });
    addStroke(doc, { tool: 'highlighter', color: '#ffff00', width: 12, points: [5, 5] });
    expect(readPage(doc).strokes).toHaveLength(2);
    expect(readPage(doc).strokes.find((x) => x.id === s)).toEqual({
      id: s,
      tool: 'pen',
      color: '#000000',
      width: 2,
      points: [0, 0, 10, 10],
    });
    expect(() => addStroke(doc, { tool: 'pen', color: '#000', width: 1, points: [1, 2, 3] })).toThrow(/pairs/);
    deleteStroke(doc, s);
    deleteStroke(doc, s);
    expect(readPage(doc).strokes).toHaveLength(1);
  });

  it('reads containers top to bottom, then left to right', () => {
    const doc = new Y.Doc();
    const right = addTextContainer(doc, { x: 300, y: 10, width: 10, body: para('right') });
    const lower = addTextContainer(doc, { x: 0, y: 200, width: 10, body: para('lower') });
    const left = addTextContainer(doc, { x: 0, y: 10, width: 10, body: para('left') });
    addFileContainer(doc, { x: 0, y: 300, width: 10, ...blob, name: 'report.pdf' });
    expect(readPage(doc).containers.map((c) => c.id).slice(0, 3)).toEqual([left, right, lower]);
    expect(extractPageText(doc)).toBe('left\n\nright\n\nlower\n\nreport.pdf');
  });
});
