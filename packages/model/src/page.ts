/**
 * A page doc (`pg:<id>`): paper settings, containers and strokes. Every read
 * and write of its Y.Map keys happens in this file. A page doc needs no setup;
 * an empty doc is an empty page with no paper style. The page's title and
 * times live on its node in the notebook doc.
 */
import * as Y from 'yjs';
import { newId } from './ids.js';
import { appendBody, assertValidBody, bodyToText, emptyBody, readBody, writeBody, type JSONContent } from './rich-text.js';

export const PAPER_STYLES = [
  'none',
  'ruled-narrow',
  'ruled-college',
  'ruled-standard',
  'ruled-wide',
  'grid-small',
  'grid-medium',
  'grid-large',
  'grid-xlarge',
] as const;
export type PaperStyle = (typeof PAPER_STYLES)[number];

/** Rule or grid spacing in px for each paper style, null for plain paper. The canvas and exports both draw with these. */
export const PAPER_SPACING: Record<PaperStyle, number | null> = {
  none: null,
  'ruled-narrow': 18,
  'ruled-college': 22,
  'ruled-standard': 26,
  'ruled-wide': 32,
  'grid-small': 12,
  'grid-medium': 18,
  'grid-large': 24,
  'grid-xlarge': 36,
};

export interface PageMeta {
  paperStyle: PaperStyle;
  /** `#rrggbb`, or null for plain white. */
  paperColor: string | null;
}

/** Lengths are CSS px from the canvas origin, the top-left of the area under the title block. */
interface ContainerBase {
  id: string;
  x: number;
  y: number;
  width: number;
  /** Stacking order; higher draws on top. */
  z: number;
}

export interface TextContainer extends ContainerBase {
  kind: 'text';
  body: JSONContent;
}

export interface BlobRef {
  /** SHA-256 hex of the bytes. */
  blob: string;
  mime: string;
  name: string;
  /** Bytes. */
  size: number;
}

export interface ImageContainer extends ContainerBase, BlobRef {
  kind: 'image';
  height: number;
}

export interface FileContainer extends ContainerBase, BlobRef {
  kind: 'file';
}

export type Container = TextContainer | ImageContainer | FileContainer;

export type StrokeTool = 'pen' | 'marker' | 'highlighter';

export interface Stroke {
  tool: StrokeTool;
  color: string;
  /** Line width in px. */
  width: number;
  /** `[x0, y0, x1, y1, …]` in px from the canvas origin. */
  points: number[];
}

export interface PageSnapshot {
  meta: PageMeta;
  /** In reading order: top to bottom, then left to right. */
  containers: Container[];
  /** Sorted by id. */
  strokes: Array<Stroke & { id: string }>;
}

export type Restack = 'forward' | 'front' | 'backward' | 'back';

const meta = (doc: Y.Doc) => doc.getMap<unknown>('meta');
const containers = (doc: Y.Doc) => doc.getMap<Y.Map<unknown>>('containers');
const strokes = (doc: Y.Doc) => doc.getMap<Stroke>('strokes');

function getContainerMap(doc: Y.Doc, id: string): Y.Map<unknown> {
  const map = containers(doc).get(id);
  if (!map) throw new Error(`Container ${id} is not on this page`);
  return map;
}

function assertFinite(what: string, ...values: number[]): void {
  if (!values.every(Number.isFinite)) throw new Error(`${what} must be finite numbers, got ${values.join(', ')}`);
}

export function readPageMeta(doc: Y.Doc): PageMeta {
  const style = meta(doc).get('paperStyle');
  const color = meta(doc).get('paperColor');
  return {
    paperStyle: PAPER_STYLES.includes(style as PaperStyle) ? (style as PaperStyle) : 'none',
    paperColor: typeof color === 'string' ? color : null,
  };
}

export function setPaperStyle(doc: Y.Doc, style: PaperStyle): void {
  if (!PAPER_STYLES.includes(style)) throw new Error(`"${style}" is not a paper style`);
  meta(doc).set('paperStyle', style);
}

export function setPaperColor(doc: Y.Doc, color: string | null): void {
  meta(doc).set('paperColor', color);
}

function insertContainer(doc: Y.Doc, fields: Record<string, unknown>, body?: JSONContent): string {
  const id = newId();
  const z = Math.max(-1, ...readContainers(doc).map((c) => c.z)) + 1;
  doc.transact(() => {
    const map = new Y.Map<unknown>();
    containers(doc).set(id, map);
    for (const [key, value] of Object.entries(fields)) map.set(key, value);
    map.set('z', z);
    if (body) {
      const fragment = new Y.XmlFragment();
      map.set('body', fragment);
      writeBody(fragment, body);
    }
  });
  return id;
}

/** Adds a text container on top of the others and returns its id. The body defaults to one empty paragraph. */
export function addTextContainer(
  doc: Y.Doc,
  input: { x: number; y: number; width: number; body?: JSONContent },
): string {
  assertFinite('Container position and width', input.x, input.y, input.width);
  const body = input.body ?? emptyBody();
  assertValidBody(body);
  return insertContainer(doc, { kind: 'text', x: input.x, y: input.y, width: input.width }, body);
}

/** Where `appendToPage` puts a text container on a page that has none, matching where the web client places new content. */
const APPENDED_CONTAINER = { x: 48, width: 400, gap: 24 } as const;
/** The height the web client draws a file container at; file containers store no height. */
const FILE_CONTAINER_HEIGHT = 64;

/**
 * Adds the body's blocks after everything in the page's last text container
 * in reading order, the order the exports use. On a page with no text
 * container it adds one at the left margin, below every picture and file.
 * Nothing already on the page changes. Returns the container's id. Throws
 * when the body does not fit the rich-text schema.
 */
export function appendToPage(doc: Y.Doc, body: JSONContent): string {
  assertValidBody(body);
  const ordered = readContainers(doc).sort(byReadingOrder);
  const last = ordered.filter((c) => c.kind === 'text').at(-1);
  if (last !== undefined) {
    appendBody(textContainerBody(doc, last.id), body);
    return last.id;
  }
  const bottom = Math.max(0, ...ordered.map((c) => c.y + (c.kind === 'image' ? c.height : FILE_CONTAINER_HEIGHT)));
  const { x, width, gap } = APPENDED_CONTAINER;
  return addTextContainer(doc, { x, y: bottom + gap, width, body });
}

/** Adds a picture on top of the others and returns its id. The blob must already be stored. */
export function addImageContainer(
  doc: Y.Doc,
  input: { x: number; y: number; width: number; height: number } & BlobRef,
): string {
  assertFinite('Picture position and size', input.x, input.y, input.width, input.height);
  const { x, y, width, height, blob, mime, name, size } = input;
  return insertContainer(doc, { kind: 'image', x, y, width, height, blob, mime, name, size });
}

/** Adds an attached file on top of the others and returns its id. The blob must already be stored. */
export function addFileContainer(doc: Y.Doc, input: { x: number; y: number; width: number } & BlobRef): string {
  assertFinite('File position and width', input.x, input.y, input.width);
  const { x, y, width, blob, mime, name, size } = input;
  return insertContainer(doc, { kind: 'file', x, y, width, blob, mime, name, size });
}

export function moveContainer(doc: Y.Doc, id: string, to: { x: number; y: number }): void {
  assertFinite(`Position of container ${id}`, to.x, to.y);
  const map = getContainerMap(doc, id);
  doc.transact(() => {
    map.set('x', to.x);
    map.set('y', to.y);
  });
}

/** Sets a container's width, and for a picture its height. Height on any other kind throws. */
export function resizeContainer(doc: Y.Doc, id: string, size: { width: number; height?: number }): void {
  const map = getContainerMap(doc, id);
  assertFinite(`Size of container ${id}`, size.width, size.height ?? 0);
  if (size.height !== undefined && map.get('kind') !== 'image') {
    throw new Error(`Container ${id} is a ${String(map.get('kind'))} container; only pictures have a height`);
  }
  doc.transact(() => {
    map.set('width', size.width);
    if (size.height !== undefined) map.set('height', size.height);
  });
}

/** Moves a container one step up or down the stack, or to the top or bottom. */
export function restackContainer(doc: Y.Doc, id: string, how: Restack): void {
  getContainerMap(doc, id);
  const stack = readContainers(doc).sort((a, b) => a.z - b.z || (a.id < b.id ? -1 : 1));
  const from = stack.findIndex((c) => c.id === id);
  const to = { front: stack.length - 1, back: 0, forward: from + 1, backward: from - 1 }[how];
  const [moved] = stack.splice(from, 1);
  stack.splice(Math.max(0, Math.min(to, stack.length)), 0, moved!);
  doc.transact(() => {
    stack.forEach((c, z) => {
      if (c.z !== z) getContainerMap(doc, c.id).set('z', z);
    });
  });
}

/** Removes a container and its content. Removing one that is gone does nothing. */
export function deleteContainer(doc: Y.Doc, id: string): void {
  containers(doc).delete(id);
}

/** The live rich-text body of a text container, for binding an editor to it. */
export function textContainerBody(doc: Y.Doc, id: string): Y.XmlFragment {
  const body = getContainerMap(doc, id).get('body');
  if (!(body instanceof Y.XmlFragment)) throw new Error(`Container ${id} is not a text container`);
  return body;
}

/** The live rich-text bodies of every text container, in reading order. */
export function textContainerBodies(doc: Y.Doc): Y.XmlFragment[] {
  const found: Array<{ id: string; x: number; y: number; body: Y.XmlFragment }> = [];
  containers(doc).forEach((map, id) => {
    const body = map.get('body');
    if (map.get('kind') !== 'text' || !(body instanceof Y.XmlFragment)) return;
    found.push({ id, x: Number(map.get('x') ?? 0), y: Number(map.get('y') ?? 0), body });
  });
  return found.sort((a, b) => a.y - b.y || a.x - b.x || (a.id < b.id ? -1 : 1)).map((c) => c.body);
}

/** Adds a stroke and returns its id. A stroke is never edited; erasing deletes it. */
export function addStroke(doc: Y.Doc, stroke: Stroke): string {
  if (stroke.points.length < 2 || stroke.points.length % 2 !== 0) {
    throw new Error(`A stroke needs x, y pairs; got ${stroke.points.length} numbers`);
  }
  assertFinite('Stroke width and points', stroke.width, ...stroke.points);
  const id = newId();
  strokes(doc).set(id, { tool: stroke.tool, color: stroke.color, width: stroke.width, points: [...stroke.points] });
  return id;
}

/** Erases a stroke. Erasing one that is gone does nothing. */
export function deleteStroke(doc: Y.Doc, id: string): void {
  strokes(doc).delete(id);
}

function readContainers(doc: Y.Doc): Container[] {
  const list: Container[] = [];
  containers(doc).forEach((map, id) => {
    const base = {
      id,
      x: Number(map.get('x') ?? 0),
      y: Number(map.get('y') ?? 0),
      width: Number(map.get('width') ?? 0),
      z: Number(map.get('z') ?? 0),
    };
    const kind = map.get('kind');
    if (kind === 'text') {
      const body = map.get('body');
      list.push({ ...base, kind, body: body instanceof Y.XmlFragment ? readBody(body) : emptyBody() });
      return;
    }
    const blob = {
      blob: String(map.get('blob') ?? ''),
      mime: String(map.get('mime') ?? 'application/octet-stream'),
      name: String(map.get('name') ?? ''),
      size: Number(map.get('size') ?? 0),
    };
    if (kind === 'image') list.push({ ...base, ...blob, kind, height: Number(map.get('height') ?? 0) });
    else if (kind === 'file') list.push({ ...base, ...blob, kind });
  });
  return list;
}

/** Reading order: top to bottom, then left to right. Every export and the mirror read a page in this order. */
function byReadingOrder(a: Container, b: Container): number {
  return a.y - b.y || a.x - b.x || (a.id < b.id ? -1 : 1);
}

/** A plain copy of the page, for export and search. */
export function readPage(doc: Y.Doc): PageSnapshot {
  const ordered = readContainers(doc).sort(byReadingOrder);
  const strokeList: PageSnapshot['strokes'] = [];
  strokes(doc).forEach((s, id) => strokeList.push({ id, ...s, points: [...s.points] }));
  strokeList.sort((a, b) => (a.id < b.id ? -1 : 1));
  return { meta: readPageMeta(doc), containers: ordered, strokes: strokeList };
}

/** The page's words in reading order, for search: text bodies and file and picture names. */
export function extractPageText(doc: Y.Doc): string {
  return readPage(doc)
    .containers.map((c) => (c.kind === 'text' ? bodyToText(c.body) : c.name))
    .filter((text) => text.trim() !== '')
    .join('\n\n');
}
