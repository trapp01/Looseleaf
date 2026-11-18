/**
 * Turning a To Do line into a card: a new page whose id is the line's id and
 * whose title is the line's text, filed in the Unfiled section and put on the
 * board in the chosen status with a link back to the page the line came
 * from; the line itself becomes a card link. Since the new page takes the
 * line's id, two replicas that promote the same line while apart end with one
 * page and one card.
 */
import { boardDocId, notebookDocId, pageDocId } from '../ids.js';
import { getNode } from '../notebook.js';
import { changeTodoLines, listTodoLines, turnLineIntoCardLink } from '../todo-lines.js';
import { cardNumber, putOnBoard } from './cards.js';
import { fileNewPage, recordUnfiled, requireBoard, unfiledSectionId, type DocAccess } from './filing.js';
import { looseleafTarget } from './refs.js';

export interface PromoteLine {
  notebookId: string;
  /** The page the line is on. */
  sourcePageId: string;
  lineId: string;
  /** The board's first `todo` status when left out. */
  statusId?: string;
  by: string;
  now?: number;
}

/**
 * Makes the line a card, as described above, and resolves with the new
 * page's id (the line id) and the card's number. Running it again for a line
 * already promoted resolves with the same card and changes nothing. Throws
 * when the notebook has no board, or the page has no To Do line with this id
 * and no card was made from it.
 */
export async function promoteTodoLine(access: DocAccess, input: PromoteLine): Promise<{ pageId: string; number: number }> {
  const pageId = input.lineId;
  const known = await access.withDoc(boardDocId(input.notebookId), (board) => {
    requireBoard(board);
    return cardNumber(board, pageId);
  });
  const line = await access.withDoc(pageDocId(input.sourcePageId), (page) => listTodoLines(page).find((candidate) => candidate.id === input.lineId) ?? null);
  if (line === null) {
    if (known !== null) return { pageId, number: known };
    throw new Error(`Page "${input.sourcePageId}" has no To Do line with the id "${input.lineId}"`);
  }
  const sourceTitle = await access.withDoc(notebookDocId(input.notebookId), (notebook) => {
    fileNewPage(notebook, input.notebookId, { sectionId: null, title: line.text.trim() || 'Untitled', pageId });
    return getNode(notebook, input.sourcePageId)?.name ?? '';
  });
  const number = await access.withDoc(boardDocId(input.notebookId), (board) => {
    recordUnfiled(board, unfiledSectionId(input.notebookId));
    return putOnBoard(board, pageId, {
      statusId: input.statusId,
      links: [{ target: looseleafTarget(input.sourcePageId), title: sourceTitle }],
      by: input.by,
      now: input.now,
    });
  });
  await changeTodoLines(access, { notebookId: input.notebookId, pageId: input.sourcePageId }, (page) => turnLineIntoCardLink(page, input.lineId, pageId));
  return { pageId, number };
}
