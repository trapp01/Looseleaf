import { nanoid } from 'nanoid';

/** A new 21-character nanoid for a notebook, node, container, stroke, or anything on a board. */
export function newId(): string {
  return nanoid();
}

/** The id of the doc that lists every notebook. */
export const LIBRARY_DOC_ID = 'library';

/** The id of the doc that holds one notebook's tree of nodes. */
export function notebookDocId(notebookId: string): string {
  return `nb:${notebookId}`;
}

/** The id of the doc that holds one page's containers and strokes. */
export function pageDocId(pageId: string): string {
  return `pg:${pageId}`;
}

const BOARD_DOC_PREFIX = 'board:';

/** The id of the doc that holds a notebook's board. Keyed by the notebook so a notebook has at most one. */
export function boardDocId(notebookId: string): string {
  return `${BOARD_DOC_PREFIX}${notebookId}`;
}

/** The notebook id a board doc id names, or null for any other doc. */
export function notebookIdOfBoardDoc(docId: string): string | null {
  return docId.startsWith(BOARD_DOC_PREFIX) ? docId.slice(BOARD_DOC_PREFIX.length) : null;
}
