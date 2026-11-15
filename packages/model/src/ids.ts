import { nanoid } from 'nanoid';

/** A new 21-character nanoid for a notebook, node, container or stroke. */
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
