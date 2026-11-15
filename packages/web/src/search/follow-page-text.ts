import type * as Y from 'yjs';
import { extractPageText, getNode } from '@looseleaf/model';
import type { SearchIndex } from './search-index.js';

const SEARCH_TEXT_DELAY_MS = 3000;

/**
 * Hands the open page's text to search once edits pause for `delayMs`, without
 * waiting for the background pass. The returned stop function writes any text
 * still waiting, so closing the page straight after typing keeps it searchable.
 */
export function followPageText(
  doc: Y.Doc,
  notebookDoc: Y.Doc,
  pageId: string,
  search: Pick<SearchIndex, 'setPageText'>,
  delayMs = SEARCH_TEXT_DELAY_MS,
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const write = () => {
    timer = null;
    search.setPageText(pageId, extractPageText(doc), getNode(notebookDoc, pageId)?.modifiedAt ?? 0);
  };
  const onUpdate = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(write, delayMs);
  };
  doc.on('update', onUpdate);
  return () => {
    doc.off('update', onUpdate);
    if (!timer) return;
    clearTimeout(timer);
    write();
  };
}
