/**
 * A page's content ([MS-ONE] 2.2.19–2.2.32) to import-tree containers:
 * outlines become text containers, pictures and attached files placed on the
 * page become blob containers, and outline elements become paragraphs, lists,
 * tables and inline pictures. The outline element tree is walked with an
 * explicit stack, so deep indentation cannot overflow the call stack.
 */
import type {
  ImportedBlobContainer,
  ImportedBlock,
  ImportedContainer,
  ImportedInlineImage,
  ImportedList,
  ImportedTable,
  ImportedTableCell,
} from '../../model/src/import-tree.js';
import { ByteReader, type ExGuid } from './bytes.js';
import { InkJcid, Jcid } from './jcids.js';
import { isBrowserImage, mimeFor } from './mime.js';
import { PropertyId as P } from './property-ids.js';
import type { PropertySet } from './property-set.js';
import type { StoreObject } from './revision-store.js';
import { colorRefToHex, readParagraph, warnUntaggable, type ContentContext } from './rich-text.js';

/**
 * Layout lengths in [MS-ONE] are floats in half-inch increments (2.3.18,
 * 2.3.21). A CSS px is 1/96 inch, so one half-inch is 48 px.
 */
export const PX_PER_HALF_INCH = 48;

export function halfInchesToPx(value: number): number {
  return Math.round(value * PX_PER_HALF_INCH * 100) / 100;
}

// Tables nest through cells; a chain this deep only comes from corrupt references.
const MAX_TABLE_NESTING = 16;

export interface PageContentContext extends ContentContext {
  /** Objects already placed on this page; a second visit means a reference cycle. */
  visited: Set<ExGuid>;
}

/** An attached file read from the page, before it is given a position. */
type FileBlob = Omit<ImportedBlobContainer, 'x' | 'y'>;

export interface PageContent {
  containers: ImportedContainer[];
  /** Ink strokes found on the page, which this reader counts but does not decode. */
  inkStrokes: number;
}

/** Reads the containers of a jcidPageNode, skipping the title node (it becomes the page title). */
export function readPageContent(page: StoreObject, ctx: PageContentContext): PageContent {
  const containers: ImportedContainer[] = [];
  let inkStrokes = 0;
  for (const child of children(page.props, P.ElementChildNodes, ctx)) {
    switch (child.jcid) {
      case Jcid.OutlineNode:
        containers.push(...readOutline(child, ctx));
        break;
      case Jcid.ImageNode: {
        const image = readImage(child, ctx);
        if (image) {
          if (child.props.bool(P.IsBackground)) ctx.warn('Background picture imported as a normal picture');
          containers.push({
            kind: 'image',
            ...position(child.props),
            width: image.width ?? 0,
            ...(image.height !== undefined ? { height: image.height } : {}),
            data: image.data,
            mime: image.mime,
            name: child.props.string(P.ImageFilename) || 'picture',
          });
        }
        break;
      }
      case Jcid.EmbeddedFileNode: {
        const file = readEmbeddedFile(child, ctx);
        if (file) containers.push({ ...file, ...position(child.props) });
        break;
      }
      case InkJcid.InkContainer:
        inkStrokes += countInkStrokes(child, ctx);
        break;
      default:
        ctx.warn('Content of an unknown kind not imported');
    }
  }
  return { containers, inkStrokes };
}

/** The objects a property references, skipping missing ones and ones already visited. */
function children(props: PropertySet, propertyId: number, ctx: PageContentContext): StoreObject[] {
  const out: StoreObject[] = [];
  for (const id of props.objectIds(propertyId)) {
    if (ctx.visited.has(id)) continue;
    ctx.visited.add(id);
    const object = ctx.object(id);
    if (!object) {
      ctx.warn('Content that refers to a missing object was skipped');
      continue;
    }
    if (object.damage) ctx.warn('Damaged content was skipped');
    else out.push(object);
  }
  return out;
}

/**
 * OneNote measures a page from its top-left corner, above the title, and puts
 * the first outline of a new page at y = 91 px. An import tree measures from
 * under the title block, so this much comes off every y.
 */
export const TITLE_BLOCK_HEIGHT_PX = 80;

/** OffsetFromParentHoriz/Vert (2.3.18–19), in half-inches, as px from the canvas origin. */
function position(props: PropertySet): { x: number; y: number } {
  const y = halfInchesToPx(props.float(P.OffsetFromParentVert) ?? 0) - TITLE_BLOCK_HEIGHT_PX;
  return {
    x: halfInchesToPx(props.float(P.OffsetFromParentHoriz) ?? 0),
    y: Math.max(0, y),
  };
}

/** An outline as a text container, plus any attached files it held, placed at the outline's corner. */
function readOutline(outline: StoreObject, ctx: PageContentContext): ImportedContainer[] {
  const files: FileBlob[] = [];
  const blocks = readBlocks(children(outline.props, P.ElementChildNodes, ctx), ctx, files, 0);
  const at = position(outline.props);
  // LayoutMaxWidthInOutline (2.3.22); 1.0 is the spec's default.
  const width = halfInchesToPx(outline.props.float(P.LayoutMaxWidth) ?? 1);
  const out: ImportedContainer[] = [];
  if (blocks.length > 0) out.push({ kind: 'text', ...at, width, blocks });
  if (files.length > 0) ctx.warn('Attached file moved out of its note container');
  for (const file of files) out.push({ ...file, ...at });
  return out;
}

interface Frame {
  elements: StoreObject[];
  next: number;
  out: ImportedBlock[];
  /** The list the previous sibling added an item to, which the next list item joins. */
  list: ImportedList | undefined;
  /** Indent steps for plain paragraphs in this frame. */
  indent: number;
}

/**
 * Turns sibling outline elements (2.2.21) and outline groups (2.2.22) into
 * blocks. Consecutive list items of one kind merge into one list; a list
 * item's child elements nest inside the item; children of a plain paragraph
 * follow it one indent step deeper. Each nesting level and each outline group
 * is one step; OutlineElementChildLevel values above 1 are not honoured.
 */
function readBlocks(elements: StoreObject[], ctx: PageContentContext, files: FileBlob[], tableDepth: number): ImportedBlock[] {
  const root: ImportedBlock[] = [];
  const stack: Frame[] = [{ elements, next: 0, out: root, list: undefined, indent: 0 }];
  while (stack.length > 0) {
    const frame = stack[stack.length - 1]!;
    const element = frame.elements[frame.next++];
    if (!element) {
      stack.pop();
      continue;
    }
    const kids = children(element.props, P.ElementChildNodes, ctx);
    if (element.jcid === Jcid.OutlineGroup) {
      frame.list = undefined;
      stack.push({ elements: kids, next: 0, out: frame.out, list: undefined, indent: frame.indent + 1 });
      continue;
    }
    if (element.jcid !== Jcid.OutlineElementNode) {
      ctx.warn('Content of an unknown kind not imported');
      continue;
    }
    const content = readElementContent(element, ctx, files, tableDepth);
    const ordered = listKind(element, ctx);
    if (ordered === undefined) {
      frame.list = undefined;
      for (const block of content) if (block.type === 'paragraph' && frame.indent > 0) block.indent = frame.indent;
      frame.out.push(...content);
      if (kids.length > 0) stack.push({ elements: kids, next: 0, out: frame.out, list: undefined, indent: frame.indent + 1 });
      continue;
    }
    let list = frame.list;
    if (!list || list.ordered !== ordered) {
      list = { type: 'list', ordered, items: [] };
      frame.out.push(list);
      frame.list = list;
    }
    const item = { blocks: content };
    list.items.push(item);
    if (kids.length > 0) stack.push({ elements: kids, next: 0, out: item.blocks, list: undefined, indent: 0 });
  }
  return root;
}

/** True for a numbered list item, false for a bulleted one, undefined when the element is not in a list. */
function listKind(element: StoreObject, ctx: PageContentContext): boolean | undefined {
  const listNodeId = element.props.objectIds(P.ListNodes)[0];
  if (!listNodeId) return undefined;
  const listNode = ctx.object(listNodeId)?.props;
  if (!listNode) return false;
  if (listNode.has(P.ListRestart)) ctx.warn('List numbering that restarts at a set number was not kept');
  return isNumberedListFormat(listNode.bytes(P.NumberListFormat));
}

/**
 * NumberListFormat (2.3.20) is UTF-16: a length character, then the format.
 * A numbered list's format holds the numbering character U+FFFD.
 */
export function isNumberedListFormat(format: Uint8Array | undefined): boolean {
  if (!format) return false;
  const r = new ByteReader(format);
  r.skip(Math.min(2, r.remaining));
  while (r.remaining >= 2) if (r.u16() === 0xfffd) return true;
  return false;
}

/** The single content node of an outline element (2.2.46) as blocks. */
function readElementContent(element: StoreObject, ctx: PageContentContext, files: FileBlob[], tableDepth: number): ImportedBlock[] {
  const blocks: ImportedBlock[] = [];
  for (const content of children(element.props, P.ContentChildNodes, ctx)) {
    switch (content.jcid) {
      case Jcid.RichTextOENode:
        blocks.push(readParagraph(content, ctx));
        break;
      case Jcid.TableNode:
        if (tableDepth >= MAX_TABLE_NESTING) ctx.warn('Tables nested too deeply were not imported');
        else blocks.push(readTable(content, ctx, files, tableDepth + 1));
        break;
      case Jcid.ImageNode: {
        const image = readImage(content, ctx);
        if (image) blocks.push(image);
        break;
      }
      case Jcid.EmbeddedFileNode: {
        const file = readEmbeddedFile(content, ctx);
        if (file) files.push(file);
        break;
      }
      default:
        ctx.warn('Content of an unknown kind not imported');
    }
  }
  return blocks;
}

/** A jcidTableNode (2.2.26): rows of cells, each cell holding outline elements. */
function readTable(table: StoreObject, ctx: PageContentContext, files: FileBlob[], tableDepth: number): ImportedTable {
  warnUntaggable(table.props, 'table', ctx);
  const rows: ImportedTableCell[][] = [];
  for (const row of children(table.props, P.ElementChildNodes, ctx)) {
    const cells: ImportedTableCell[] = [];
    for (const cell of children(row.props, P.ElementChildNodes, ctx)) {
      const blocks = readBlocks(children(cell.props, P.ElementChildNodes, ctx), ctx, files, tableDepth);
      const background = colorRefToHex(cell.props.uint(P.CellShadingColor));
      cells.push(background ? { blocks, background } : { blocks });
    }
    rows.push(cells);
  }
  const result: ImportedTable = { type: 'table', rows };
  const widths = readColumnWidths(table.props.bytes(P.TableColumnWidths));
  if (widths) result.columnWidths = widths;
  return result;
}

/** TableColumnWidths (2.2.66): a column count byte, then one float per column in half-inches. */
export function readColumnWidths(data: Uint8Array | undefined): number[] | undefined {
  if (!data || data.length < 1) return undefined;
  const r = new ByteReader(data);
  const count = r.u8();
  const widths: number[] = [];
  for (let i = 0; i < count && r.remaining >= 4; i++) widths.push(halfInchesToPx(r.f32()));
  return widths.length > 0 && widths.every(Number.isFinite) ? widths : undefined;
}

/** A jcidImageNode (2.2.24) with its picture bytes, or undefined (with a warning) when it has none. */
function readImage(node: StoreObject, ctx: PageContentContext): ImportedInlineImage | undefined {
  const props = node.props;
  warnUntaggable(props, 'picture', ctx);
  if (props.has(P.WzHyperlinkUrl)) ctx.warn('Link on a picture not imported');
  const data = fileBytes(props.objectId(P.PictureContainer), 'Picture', ctx);
  if (!data) return undefined;
  const mime = mimeFor(data.bytes, data.extension);
  if (!isBrowserImage(mime)) ctx.warn(`Picture in ${mime} format kept as is; browsers may not show it`);
  const image: ImportedInlineImage = { type: 'image', data: data.bytes, mime };
  // PictureWidth/Height (2.3.100–101) give the displayed size; LayoutMaxWidth/Height bound it otherwise.
  const width = props.float(P.PictureWidth) ?? props.float(P.LayoutMaxWidth);
  const height = props.float(P.PictureHeight) ?? props.float(P.LayoutMaxHeight);
  if (width !== undefined && width > 0) image.width = halfInchesToPx(width);
  if (height !== undefined && height > 0) image.height = halfInchesToPx(height);
  const alt = props.string(P.ImageAltText);
  if (alt) image.alt = alt;
  return image;
}

/** A jcidEmbeddedFileNode (2.2.32) as an unplaced file blob. Audio and video recordings are files too. */
function readEmbeddedFile(node: StoreObject, ctx: PageContentContext): FileBlob | undefined {
  const props = node.props;
  warnUntaggable(props, 'file', ctx);
  const media = props.uint(P.IRecordMedia);
  if (media === 1) ctx.warn('Audio recording imported as an attached file');
  if (media === 2) ctx.warn('Video recording imported as an attached file');
  const data = fileBytes(props.objectId(P.EmbeddedFileContainer), 'Attached file', ctx);
  if (!data) return undefined;
  const name = props.string(P.EmbeddedFileName) || `attachment${data.extension}`;
  const width = props.float(P.PictureWidth) ?? props.float(P.LayoutMaxWidth) ?? 1;
  const height = props.float(P.PictureHeight) ?? props.float(P.LayoutMaxHeight);
  return {
    kind: 'file',
    width: halfInchesToPx(width),
    ...(height !== undefined ? { height: halfInchesToPx(height) } : {}),
    data: data.bytes,
    mime: mimeFor(data.bytes, name),
    name,
  };
}

/** The bytes of a file data object, or undefined with a warning saying why they are missing. */
function fileBytes(id: ExGuid | undefined, what: string, ctx: PageContentContext): { bytes: Uint8Array; extension: string } | undefined {
  const file = id ? ctx.object(id)?.file : undefined;
  // A copy, so the import tree does not keep the whole section file's buffer alive.
  if (file?.kind === 'stored') return { bytes: file.data.slice(), extension: file.extension };
  if (file?.kind === 'external') ctx.warn(`${what} not imported: its data is kept outside the section file`);
  else ctx.warn(`${what} not imported: its data is missing`);
  return undefined;
}

// Ink objects are few per drawing; this bounds the walk on a corrupt reference graph.
const MAX_INK_OBJECTS = 100_000;

/** Counts the ink stroke objects reachable from an ink container. */
function countInkStrokes(container: StoreObject, ctx: PageContentContext): number {
  let strokes = 0;
  const seen = new Set<ExGuid>([container.id]);
  const queue: StoreObject[] = [container];
  while (queue.length > 0 && seen.size < MAX_INK_OBJECTS) {
    const object = queue.pop()!;
    if (object.jcid === InkJcid.InkStroke) strokes++;
    for (const value of object.props.values.values()) {
      if (value.kind !== 'objects') continue;
      for (const id of value.value) {
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const next = ctx.object(id);
        if (next) queue.push(next);
      }
    }
  }
  return strokes;
}
