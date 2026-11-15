/**
 * Turns an import tree into docs: a new notebook in the library, its nodes,
 * and one page doc per page with containers, rich text and strokes.
 */
import type * as Y from 'yjs';
import { isColorName, nearestColor, type ColorName } from './colors.js';
import { LIBRARY_DOC_ID, notebookDocId, pageDocId } from './ids.js';
import type {
  ImportedBlock,
  ImportedNotebook,
  ImportedPage,
  ImportedParagraph,
  ImportedRun,
  ImportedSection,
  ImportedSectionGroup,
} from './import-tree.js';
import { createNotebook, deleteNotebook } from './library.js';
import { createGroup, createPage, createSection } from './notebook.js';
import { addFileContainer, addImageContainer, addStroke, addTextContainer } from './page.js';
import { emptyBody, safeHref, type JSONContent } from './rich-text.js';

/** Where an import writes. `putBlob` stores the bytes and resolves their SHA-256 hex. */
export interface DocSink {
  getDoc(docId: string): Promise<Y.Doc>;
  putBlob(bytes: Uint8Array, mime: string): Promise<string>;
}

export interface ImportSummary {
  notebookId: string;
  groups: number;
  sections: number;
  pages: number;
  containers: number;
  strokes: number;
  blobs: number;
  /** The importer's warnings and this step's own, each prefixed with `Section / Page title: `. */
  warnings: string[];
}

/**
 * Creates the notebook and everything in it. The notebook goes last in the
 * library. A text container whose content cannot be represented is skipped
 * with a warning instead of failing the import. When a sink call fails after
 * the notebook exists, the partial notebook is moved to Deleted notes and the
 * error is rethrown saying so.
 */
export async function importTree(notebook: ImportedNotebook, sink: DocSink): Promise<ImportSummary> {
  const library = await sink.getDoc(LIBRARY_DOC_ID);
  const notebookId = createNotebook(library, { name: notebook.name, color: toColor(notebook.color) });
  try {
    return await fillNotebook(notebook, notebookId, sink);
  } catch (error) {
    deleteNotebook(library, notebookId);
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Importing "${notebook.name}" failed: ${reason}. The partial notebook was moved to Deleted notes.`,
      { cause: error },
    );
  }
}

async function fillNotebook(notebook: ImportedNotebook, notebookId: string, sink: DocSink): Promise<ImportSummary> {
  const nbDoc = await sink.getDoc(notebookDocId(notebookId));
  const summary: ImportSummary = {
    notebookId,
    groups: 0,
    sections: 0,
    pages: 0,
    containers: 0,
    strokes: 0,
    blobs: 0,
    warnings: [],
  };

  const putBlob = async (bytes: Uint8Array, mime: string) => {
    summary.blobs++;
    return sink.putBlob(bytes, mime);
  };

  const addChildren = async (children: Array<ImportedSectionGroup | ImportedSection>, parent: string | null) => {
    for (const child of children) {
      if (child.kind === 'group') {
        const id = createGroup(nbDoc, { name: child.name, parent });
        summary.groups++;
        await addChildren(child.children, id);
      } else {
        const id = createSection(nbDoc, { name: child.name, color: toColor(child.color), parent });
        summary.sections++;
        for (const page of child.pages) await addPage(child, page, id);
      }
    }
  };

  const addPage = async (section: ImportedSection, page: ImportedPage, sectionId: string) => {
    const pageId = createPage(nbDoc, {
      section: sectionId,
      title: page.title,
      level: page.level,
      createdAt: page.createdAt,
      modifiedAt: page.modifiedAt,
    });
    summary.pages++;
    const warn = (text: string) => summary.warnings.push(`${section.name} / ${page.title}: ${text}`);
    page.warnings.forEach(warn);
    const pageDoc = await sink.getDoc(pageDocId(pageId));
    for (const c of page.containers) {
      if (c.kind === 'text') {
        const body: JSONContent = { type: 'doc', content: await blocksToJson(c.blocks, putBlob, warn) };
        if (body.content!.length === 0) body.content = emptyBody().content;
        try {
          addTextContainer(pageDoc, { x: c.x, y: c.y, width: c.width, body });
          summary.containers++;
        } catch (error) {
          warn(`a text container was left out: ${(error as Error).message}`);
        }
        continue;
      }
      const blob = await putBlob(c.data, c.mime);
      const ref = { blob, mime: c.mime, name: c.name, size: c.data.length };
      if (c.kind === 'image') {
        if (c.height === undefined) warn(`picture "${c.name}" has no height; it is shown square`);
        addImageContainer(pageDoc, { x: c.x, y: c.y, width: c.width, height: c.height ?? c.width, ...ref });
      } else {
        addFileContainer(pageDoc, { x: c.x, y: c.y, width: c.width, ...ref });
      }
      summary.containers++;
    }
    for (const stroke of page.strokes) {
      if (stroke.points.length < 2 || stroke.points.length % 2 !== 0) {
        warn(`a stroke with ${stroke.points.length} coordinates was left out`);
        continue;
      }
      addStroke(pageDoc, stroke);
      summary.strokes++;
    }
  };

  await addChildren(notebook.children, null);
  return summary;
}

function toColor(hex: string | undefined): ColorName | undefined {
  if (hex === undefined) return undefined;
  return isColorName(hex) ? hex : nearestColor(hex);
}

type PutBlob = (bytes: Uint8Array, mime: string) => Promise<string>;

async function blocksToJson(blocks: ImportedBlock[], putBlob: PutBlob, warn: (text: string) => void): Promise<JSONContent[]> {
  const out: JSONContent[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case 'paragraph':
        out.push(paragraphToJson(block, warn));
        break;
      case 'list': {
        const items: JSONContent[] = [];
        for (const item of block.items) {
          const content = await blocksToJson(item.blocks, putBlob, warn);
          // A list item opens with a body-text paragraph.
          if (content[0]?.type !== 'paragraph') content.unshift({ type: 'paragraph' });
          items.push({ type: 'listItem', content });
        }
        if (items.length > 0) out.push({ type: block.ordered ? 'orderedList' : 'bulletList', content: items });
        break;
      }
      case 'table': {
        const rows: JSONContent[] = [];
        for (const row of block.rows) {
          if (row.length === 0) continue;
          const cells: JSONContent[] = [];
          for (const [i, cell] of row.entries()) {
            const content = await blocksToJson(cell.blocks, putBlob, warn);
            const width = block.columnWidths?.[i];
            const background = cell.background !== undefined && HEX_COLOR.test(cell.background) ? cell.background : null;
            cells.push({
              type: 'tableCell',
              attrs: { colwidth: width ? [Math.round(width)] : null, background },
              content: content.length > 0 ? content : [{ type: 'paragraph' }],
            });
          }
          rows.push({ type: 'tableRow', content: cells });
        }
        if (rows.length > 0) out.push({ type: 'table', content: rows });
        else warn('an empty table was left out');
        break;
      }
      case 'image': {
        const blob = await putBlob(block.data, block.mime);
        out.push({
          type: 'image',
          attrs: {
            blob,
            mime: block.mime,
            width: block.width ?? null,
            height: block.height ?? null,
            alt: block.alt ?? null,
          },
        });
        break;
      }
    }
  }
  return out;
}

/** The only cell background an import keeps; anything else would land in a style attribute. */
const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

function paragraphToJson(p: ImportedParagraph, warn: (text: string) => void): JSONContent {
  const attrs = {
    tag: p.tag ?? null,
    checked: p.tag === 'todo' && p.checked === true,
    style: p.style ?? null,
    textAlign: p.align ?? null,
    indent: Math.max(0, Math.round(p.indent ?? 0)),
    ...(p.heading ? { level: p.heading } : {}),
  };
  const content = p.runs.flatMap((run) => runToJson(run, warn));
  return { type: p.heading ? 'heading' : 'paragraph', attrs, ...(content.length ? { content } : {}) };
}

/**
 * A run as text nodes, with each newline as a hard break. Empty runs produce
 * nothing. A link whose address the exporters would not keep becomes plain text.
 */
function runToJson(run: ImportedRun, warn: (text: string) => void): JSONContent[] {
  const marks: NonNullable<JSONContent['marks']> = [];
  if (run.bold) marks.push({ type: 'bold' });
  if (run.italic) marks.push({ type: 'italic' });
  if (run.underline) marks.push({ type: 'underline' });
  if (run.strike) marks.push({ type: 'strike' });
  if (run.subscript) marks.push({ type: 'subscript' });
  else if (run.superscript) marks.push({ type: 'superscript' });
  if (run.highlight) marks.push({ type: 'highlight', attrs: { color: run.highlight } });
  if (run.color || run.fontFamily || run.fontSize) {
    marks.push({
      type: 'textStyle',
      attrs: { color: run.color ?? null, fontFamily: run.fontFamily ?? null, fontSize: run.fontSize ?? null },
    });
  }
  if (run.link) {
    const href = safeHref(run.link);
    if (href !== null) marks.push({ type: 'link', attrs: { href } });
    else warn('a link with an unsupported address was imported as plain text');
  }
  const nodes: JSONContent[] = [];
  run.text.split(/\r\n|\r|\n/).forEach((line, i) => {
    if (i > 0) nodes.push({ type: 'hardBreak' });
    if (line) nodes.push({ type: 'text', text: line, ...(marks.length ? { marks } : {}) });
  });
  return nodes;
}
