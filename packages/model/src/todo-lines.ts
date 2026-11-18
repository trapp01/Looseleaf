/**
 * To Do lines in a page doc: reading them, ticking one, keeping one out of the
 * Inbox, adding one, and turning one into a card link. A line is found by its
 * `lineId`; a line with no id (an imported one) is listed with a null id and
 * cannot be changed through here. Changes are attribute writes on the line's
 * element, so they merge with typing in the same line on another replica.
 * Code outside the editor makes these changes inside `changeTodoLines`.
 */
import * as Y from 'yjs';
import type { DocAccess } from './board/filing.js';
import { notebookDocId, pageDocId } from './ids.js';
import { touchNode } from './notebook.js';
import { appendToPage, readPage, textContainerBodies } from './page.js';
import { inlineText, type JSONContent } from './rich-text.js';
import { SYSTEM_STAMP, tagTodoLine, type TodoLineStamp } from './todo-line-ids.js';

export interface TodoLine {
  /** Null for a line made by an importer that leaves ids empty. */
  id: string | null;
  text: string;
  checked: boolean;
  /** Epoch ms when the line was tagged To Do; null for an imported line. */
  taggedAt: number | null;
  /** False once someone chose "Keep it as a line". */
  inbox: boolean;
}

const LINE_TYPES = new Set(['paragraph', 'heading']);

/** Whether a line's content is nothing but card links: what a line turned into a card holds. */
function onlyCardLinks(children: ReadonlyArray<{ type: string; pageId: unknown }>, pageId?: string): boolean {
  return children.length > 0 && children.every((child) => child.type === 'cardLink' && (pageId === undefined || child.pageId === pageId));
}

/**
 * Every To Do line on the page in reading order: containers top to bottom
 * and left to right, then each body from start to end, lists and tables
 * included. A line holding nothing but card links is not one, whatever its
 * tag. This is the one reader of a page's lines; the Inbox, a card's
 * checklist and the line index all come from it.
 */
export function listTodoLines(doc: Y.Doc): TodoLine[] {
  const lines: TodoLine[] = [];
  const walk = (node: JSONContent): void => {
    if (node.type !== undefined && LINE_TYPES.has(node.type)) {
      const a = node.attrs ?? {};
      if (a.tag !== 'todo') return;
      if (onlyCardLinks((node.content ?? []).map((child) => ({ type: child.type ?? '', pageId: child.attrs?.pageId })))) return;
      lines.push({
        id: typeof a.lineId === 'string' && a.lineId !== '' ? a.lineId : null,
        text: inlineText(node),
        checked: a.checked === true,
        taggedAt: typeof a.taggedAt === 'number' ? a.taggedAt : null,
        inbox: a.inbox !== false,
      });
      return;
    }
    node.content?.forEach(walk);
  };
  for (const container of readPage(doc).containers) if (container.kind === 'text') walk(container.body);
  return lines;
}

/**
 * Runs `change` on a page's doc and then marks the page's node modified, and
 * resolves with what `change` returned. Every change to a page's To Do lines
 * made outside its editor (a tick, "Keep it as a line", added lines, a line
 * turned into a card link) goes through here, since clients read a page's
 * lines again only when its node's modified time changes.
 */
export async function changeTodoLines<T>(access: DocAccess, page: { notebookId: string; pageId: string }, change: (doc: Y.Doc) => T): Promise<T> {
  const result = await access.withDoc(pageDocId(page.pageId), change);
  await access.withDoc(notebookDocId(page.notebookId), (notebook) => touchNode(notebook, page.pageId));
  return result;
}

/** The paragraph or heading with this line id, To Do or not, or null. */
function findLine(doc: Y.Doc, lineId: string): Y.XmlElement | null {
  const search = (parent: Y.XmlFragment | Y.XmlElement): Y.XmlElement | null => {
    for (const child of parent.toArray()) {
      if (!(child instanceof Y.XmlElement)) continue;
      if (LINE_TYPES.has(child.nodeName)) {
        if (child.getAttribute('lineId') === lineId) return child;
        continue;
      }
      const found = search(child);
      if (found !== null) return found;
    }
    return null;
  };
  for (const body of textContainerBodies(doc)) {
    const found = search(body);
    if (found !== null) return found;
  }
  return null;
}

/** y-prosemirror stores attributes with their JSON types, though Yjs types them as strings. */
function setFlag(line: Y.XmlElement, name: string, value: boolean): void {
  (line as unknown as Y.XmlElement<Record<string, boolean>>).setAttribute(name, value);
}

function elementChildren(line: Y.XmlElement): Array<{ type: string; pageId: unknown }> {
  return line.toArray().map((child) => (child instanceof Y.XmlElement ? { type: child.nodeName, pageId: child.getAttribute('pageId') } : { type: 'text', pageId: null }));
}

/** The To Do line with this id, as `listTodoLines` would list it, or null. */
function findTodoLine(doc: Y.Doc, lineId: string): Y.XmlElement | null {
  const line = findLine(doc, lineId);
  return line !== null && line.getAttribute('tag') === 'todo' && !onlyCardLinks(elementChildren(line)) ? line : null;
}

/** Ticks or unticks a To Do line. False when the page has no To Do line with this id. */
export function setTodoLineChecked(doc: Y.Doc, lineId: string, checked: boolean): boolean {
  const line = findTodoLine(doc, lineId);
  if (line === null) return false;
  setFlag(line, 'checked', checked);
  return true;
}

/** "Keep it as a line": takes the line out of the Inbox for good. False when the page has no To Do line with this id. */
export function keepAsLine(doc: Y.Doc, lineId: string): boolean {
  const line = findTodoLine(doc, lineId);
  if (line === null) return false;
  setFlag(line, 'inbox', false);
  return true;
}

/**
 * Adds an unticked To Do line after everything in the page's last text
 * container (see `appendToPage`) and returns its id.
 */
export function appendTodoLine(doc: Y.Doc, text: string, stamp: TodoLineStamp = SYSTEM_STAMP): string {
  const attrs = tagTodoLine({ checked: false }, stamp);
  const trimmed = text.trim();
  appendToPage(doc, {
    type: 'doc',
    content: [{ type: 'paragraph', attrs, ...(trimmed === '' ? {} : { content: [{ type: 'text', text: trimmed }] }) }],
  });
  return attrs.lineId as string;
}

function holdsOnlyCardLinksTo(line: Y.XmlElement, pageId: string): boolean {
  return onlyCardLinks(elementChildren(line), pageId);
}

/** The attributes that make a paragraph a To Do line, all cleared when it becomes a card link. */
const LINE_ATTRIBUTES = ['tag', 'checked', 'lineId', 'taggedAt', 'inbox'];

/**
 * Replaces a To Do line's text with a card link to `pageId` and clears its
 * tag, tick, id, tagged-at time and Inbox choice, so the paragraph is no
 * longer a To Do line in any way: tagged again later, it is a new line with a
 * new id. False when the page has no line with this id, which includes a line
 * already turned into a card link.
 */
export function turnLineIntoCardLink(doc: Y.Doc, lineId: string, pageId: string): boolean {
  const line = findLine(doc, lineId);
  if (line === null) return false;
  doc.transact(() => {
    for (const name of LINE_ATTRIBUTES) line.removeAttribute(name);
    if (line.length > 0) line.delete(0, line.length);
    const link = new Y.XmlElement('cardLink');
    link.setAttribute('pageId', pageId);
    line.insert(0, [link]);
  });
  return true;
}

/**
 * Two replicas that turn the same line into a card link while apart each add
 * a link, so the line ends with two. This keeps the first of the links in a
 * line that holds nothing but links to one page. Every replica picks the same
 * one, so any of them may run it; servers run it on every page change they
 * store. Returns how many links it removed.
 */
export function removeDuplicateCardLinks(doc: Y.Doc): number {
  let removed = 0;
  const visit = (parent: Y.XmlFragment | Y.XmlElement): void => {
    for (const child of parent.toArray()) {
      if (!(child instanceof Y.XmlElement)) continue;
      if (!LINE_TYPES.has(child.nodeName)) {
        visit(child);
        continue;
      }
      const first = child.toArray()[0];
      if (child.length < 2 || !(first instanceof Y.XmlElement) || first.nodeName !== 'cardLink') continue;
      const pageId = first.getAttribute('pageId');
      if (typeof pageId !== 'string' || !holdsOnlyCardLinksTo(child, pageId)) continue;
      removed += child.length - 1;
      child.delete(1, child.length - 1);
    }
  };
  doc.transact(() => {
    for (const body of textContainerBodies(doc)) visit(body);
  });
  return removed;
}
