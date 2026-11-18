/**
 * Where a card's page goes. A card added on the board gets a new page filed
 * in the section tied to its first label, or in the notebook's Unfiled
 * section when no label tie applies. A page still in the Unfiled section moves
 * once, to the tied section, when its card gets its first tied label; a page
 * anywhere else is never moved by a label. The writers here change more than
 * one doc, one doc at a time through `DocAccess`, and each step can run twice
 * without harm.
 */
import type * as Y from 'yjs';
import { boardDocId, newId, notebookDocId } from '../ids.js';
import { createPage, createSection, getNode, moveNode, readTree, restoreNode, type TreeChild } from '../notebook.js';
import { metaMap, readBoardMeta, readLabels, type Label } from './board.js';
import { cardLabelIds, putOnBoard, setCardLabel, type CardPlace } from './cards.js';

/**
 * Runs a change on one doc in one transaction and resolves with what it
 * returned. The server's `Hub.withDoc` has this shape; the web client wraps
 * its replica's docs the same way.
 */
export interface DocAccess {
  withDoc<T>(docId: string, change: (doc: Y.Doc) => T): Promise<T>;
}

/** The name the Unfiled section is made with. People can rename it like any section. */
export const UNFILED_SECTION_NAME = 'Unfiled';

/** The Unfiled section's id, derived from the notebook's so two replicas that make it apart make the same one. */
export function unfiledSectionId(notebookId: string): string {
  return `${notebookId}-unfiled`;
}

function liveSectionIds(notebook: Y.Doc): Set<string> {
  const ids = new Set<string>();
  const visit = (children: TreeChild[]): void => {
    for (const child of children) {
      if (child.kind === 'group') visit(child.children);
      else ids.add(child.id);
    }
  };
  visit(readTree(notebook).children);
  return ids;
}

/**
 * The notebook's Unfiled section, made at the end of the notebook when it has
 * none and brought back when it is in Deleted notes. Returns its id.
 */
export function ensureUnfiledSection(notebook: Y.Doc, notebookId: string): string {
  const id = unfiledSectionId(notebookId);
  if (getNode(notebook, id) === null) createSection(notebook, { id, name: UNFILED_SECTION_NAME, parent: null });
  else if (!liveSectionIds(notebook).has(id)) restoreNode(notebook, id);
  return id;
}

/**
 * The section a new card's page is filed in: the tie of the first of
 * `labelIds`, in label order, whose tied section is live. Null means the
 * Unfiled section.
 */
export function filingSection(labels: readonly Label[], labelIds: readonly string[], liveSections: ReadonlySet<string>): string | null {
  const tied = labels.find((label) => labelIds.includes(label.id) && label.section !== null && liveSections.has(label.section));
  return tied?.section ?? null;
}

export function requireBoard(board: Y.Doc): void {
  if (readBoardMeta(board) === null) throw new Error('This notebook has no board');
}

/** Notes the Unfiled section in the board's meta once it is in use. */
export function recordUnfiled(board: Y.Doc, sectionId: string): void {
  if (metaMap(board).get('unfiledSection') !== sectionId) metaMap(board).set('unfiledSection', sectionId);
}

/**
 * Files a new page for a card: in `sectionId`, or the Unfiled section when it
 * is null. With `pageId`, a page that already has that id is left where it
 * is. Returns the page id and the section used.
 */
export function fileNewPage(notebook: Y.Doc, notebookId: string, input: { sectionId: string | null; title: string; pageId?: string }): { pageId: string; sectionId: string } {
  const sectionId = input.sectionId ?? ensureUnfiledSection(notebook, notebookId);
  const pageId = createPage(notebook, { section: sectionId, title: input.title, id: input.pageId });
  return { pageId, sectionId };
}

export interface NewCard {
  notebookId: string;
  title: string;
  /** The board's first `todo` status when left out. */
  statusId?: string;
  /** The top of the status when left out. */
  place?: CardPlace;
  labelIds?: string[];
  due?: string | null;
  by: string;
  now?: number;
}

/**
 * Adds a card from a title: a new page with that title, filed by its first
 * tied label or in the Unfiled section, put on the board. Throws when the
 * notebook has no board. Resolves with the page id and the card's number.
 */
export async function addCard(access: DocAccess, input: NewCard): Promise<{ pageId: string; number: number }> {
  const labels = await access.withDoc(boardDocId(input.notebookId), (board) => {
    requireBoard(board);
    return readLabels(board);
  });
  const filed = await access.withDoc(notebookDocId(input.notebookId), (notebook) => {
    const sectionId = filingSection(labels, input.labelIds ?? [], liveSectionIds(notebook));
    return fileNewPage(notebook, input.notebookId, { sectionId, title: input.title.trim() || 'Untitled', pageId: newId() });
  });
  const number = await access.withDoc(boardDocId(input.notebookId), (board) => {
    if (filed.sectionId === unfiledSectionId(input.notebookId)) recordUnfiled(board, filed.sectionId);
    const { statusId, place, labelIds, due, by, now } = input;
    return putOnBoard(board, filed.pageId, { statusId, place, labelIds, due, by, now });
  });
  return { pageId: filed.pageId, number };
}

/**
 * Puts a label on a card or takes it off. When the label is put on, has a
 * live tied section, the card had no other label with one, and the page is in
 * the Unfiled section, the page moves to the tied section. Throws when the
 * page is not a card on the notebook's board.
 */
export async function labelCard(
  access: DocAccess,
  input: { notebookId: string; pageId: string; labelId: string; on: boolean },
): Promise<void> {
  const before = await access.withDoc(boardDocId(input.notebookId), (board) => {
    const labelIds = cardLabelIds(board, input.pageId);
    setCardLabel(board, input.pageId, input.labelId, input.on);
    return { labels: readLabels(board), labelIds: labelIds.filter((id) => id !== input.labelId) };
  });
  if (!input.on) return;
  await access.withDoc(notebookDocId(input.notebookId), (notebook) => {
    const liveSections = liveSectionIds(notebook);
    const target = filingSection(before.labels, [input.labelId], liveSections);
    if (target === null || filingSection(before.labels, before.labelIds, liveSections) !== null) return;
    const page = getNode(notebook, input.pageId);
    if (page?.kind !== 'page' || page.parent !== unfiledSectionId(input.notebookId)) return;
    moveNode(notebook, input.pageId, { parent: target });
  });
}
