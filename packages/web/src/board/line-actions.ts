/**
 * To Do line changes started from the board's Inbox or a line's menu on its
 * page: ticking, "Keep it as a line" and "Make it a card in", each through
 * the model. After each one the page's lines are read back into the line
 * index, so the Inbox follows at once.
 */
import { useMemo } from 'react';
import type * as Y from 'yjs';
import {
  boardDocId,
  cardPageIds,
  changeTodoLines,
  inboxLines,
  keepAsLine,
  listTodoLines,
  livePages,
  moveCard,
  promoteTodoLine,
  setTodoLineChecked,
  type InboxLine,
} from '@looseleaf/model';
import { useServices, type Services } from '../app/services.js';
import { useStore } from '../app/store.js';
import type { CurrentBoard } from './live-board.js';

/** A To Do line, by the page it is on. */
export interface LineRef {
  notebookId: string;
  pageId: string;
  lineId: string;
}

async function changeLine(services: Services, line: LineRef, change: (page: Y.Doc) => void): Promise<void> {
  await changeTodoLines(services.access, line, (page) => {
    change(page);
    services.todoLines.set(line.pageId, line.notebookId, listTodoLines(page));
  });
}

function reportFailure(services: Services, what: string) {
  return (error: unknown) => {
    console.error(`Could not ${what}`, error);
    services.toasts.show(`Couldn’t ${what}. Try again.`);
  };
}

/** Ticks or unticks the line on its page. */
export function tickLine(services: Services, line: LineRef, checked: boolean): Promise<void> {
  return changeLine(services, line, (page) => setTodoLineChecked(page, line.lineId, checked)).catch(reportFailure(services, 'tick the line'));
}

/** "Keep it as a line": takes the line out of the Inbox for good. */
export function keepLine(services: Services, line: LineRef): Promise<void> {
  return changeLine(services, line, (page) => keepAsLine(page, line.lineId)).catch(reportFailure(services, 'keep the line'));
}

/**
 * "Make it a card in": turns the line into a card in the status, at `index`
 * among the status's cards (the top when left out), and the line into a card
 * link to it.
 */
export function makeCard(services: Services, line: LineRef, statusId: string, index = 0): Promise<void> {
  const by = services.actor.get();
  const run = async () => {
    const { pageId } = await promoteTodoLine(services.access, { notebookId: line.notebookId, sourcePageId: line.pageId, lineId: line.lineId, statusId, by });
    // A new card goes to the top; a drop lower down moves it there, which is not recorded as a move.
    if (index > 0) await services.access.withDoc(boardDocId(line.notebookId), (board) => moveCard(board, pageId, { statusId, place: index }, by));
    await changeLine(services, line, () => undefined);
  };
  return run().catch(reportFailure(services, 'make the card'));
}

/** The board's Inbox, newest first, following the line index and the board. */
export function useInbox(current: CurrentBoard): InboxLine[] {
  const { todoLines } = useServices();
  const version = useStore(todoLines.version);
  // The page tree and the cards change with the board, not with every line the background pass reads.
  const pages = useMemo(() => ({ live: livePages(current.notebookDoc), cards: cardPageIds(current.board) }), [current]);
  return useMemo(
    () => inboxLines({ createdAt: current.board.meta.createdAt, lines: todoLines.linesIn(current.notebookId), cardPageIds: pages.cards, livePages: pages.live }),
    // The index is read inside; `version` is what says it changed.
    [current, pages, todoLines, version],
  );
}
