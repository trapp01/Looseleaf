import type * as Y from 'yjs';
import { extractPageText, getNode, listTodoLines } from '@looseleaf/model';
import type { SearchIndex } from './search-index.js';
import type { TodoLineIndex } from './todo-line-index.js';

const SEARCH_TEXT_DELAY_MS = 3000;
/** Card fronts' checklist counts, the Inbox and the page's "Inbox" pills all follow the line index, so lines go there soon after typing pauses. */
export const TODO_LINES_DELAY_MS = 250;

/**
 * Hands the open page's To Do lines to the line index when the page opens
 * and once edits pause for `linesDelayMs`, and its text to search once edits
 * pause for `textDelayMs`, without waiting for the background pass. The
 * returned stop function writes anything still waiting, so closing the page
 * straight after typing keeps it searchable and counted.
 */
export function followPageText(
  doc: Y.Doc,
  notebookDoc: Y.Doc,
  page: { notebookId: string; pageId: string },
  sinks: { search: Pick<SearchIndex, 'setPageText'>; lines: Pick<TodoLineIndex, 'set'> },
  textDelayMs = SEARCH_TEXT_DELAY_MS,
  linesDelayMs = TODO_LINES_DELAY_MS,
): () => void {
  const { notebookId, pageId } = page;
  let textTimer: ReturnType<typeof setTimeout> | null = null;
  let linesTimer: ReturnType<typeof setTimeout> | null = null;
  const writeText = () => {
    textTimer = null;
    sinks.search.setPageText(pageId, extractPageText(doc), getNode(notebookDoc, pageId)?.modifiedAt ?? 0);
  };
  const writeLines = () => {
    linesTimer = null;
    sinks.lines.set(pageId, notebookId, listTodoLines(doc));
  };
  const onUpdate = () => {
    if (textTimer) clearTimeout(textTimer);
    textTimer = setTimeout(writeText, textDelayMs);
    if (linesTimer) clearTimeout(linesTimer);
    linesTimer = setTimeout(writeLines, linesDelayMs);
  };
  writeLines();
  doc.on('update', onUpdate);
  return () => {
    doc.off('update', onUpdate);
    if (linesTimer) {
      clearTimeout(linesTimer);
      writeLines();
    }
    if (textTimer) {
      clearTimeout(textTimer);
      writeText();
    }
  };
}
