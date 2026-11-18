/**
 * Which To Do lines on the open page are in its board's Inbox, for the
 * "Inbox" pills. It applies the model's one Inbox rule (`inboxLines`) to the
 * page's lines as the line index holds them, which the open page refreshes
 * soon after typing pauses (follow-page-text.ts), so the pills, the Inbox and
 * card fronts' checklist counts move together. A page of a notebook without
 * a board, and a card's own page, show none.
 */
import { cardPageIds, inboxLines, livePages } from '@looseleaf/model';
import type { PageSession } from '../canvas/page-session.js';
import type { TodoLineIndex } from '../search/todo-line-index.js';
import type { LiveBoard } from './live-board.js';

const NONE: ReadonlySet<string> = new Set();

/** Keeps `session.inbox` up to date until the returned function is called. */
export function followPageInbox(
  session: Pick<PageSession, 'notebookId' | 'pageId' | 'inbox'>,
  boards: Pick<LiveBoard, 'current'>,
  lines: Pick<TodoLineIndex, 'linesFor' | 'subscribe'>,
): () => void {
  let seen: { current: unknown; lines: unknown } = { current: undefined, lines: undefined };
  const read = () => {
    const current = boards.current.get();
    const pageLines = lines.linesFor(session.pageId);
    // The index notifies for every page it reads; only this page's lines or the board change the answer.
    if (seen.current === current && seen.lines === pageLines) return;
    seen = { current, lines: pageLines };
    if (!current || current.notebookId !== session.notebookId || pageLines.length === 0) return session.inbox.set(NONE);
    const ids = inboxLines({
      createdAt: current.board.meta.createdAt,
      lines: new Map([[session.pageId, pageLines]]),
      cardPageIds: cardPageIds(current.board),
      livePages: livePages(current.notebookDoc),
    }).map((line) => line.id);
    const held = session.inbox.get();
    if (ids.length !== held.size || ids.some((id) => !held.has(id))) session.inbox.set(ids.length === 0 ? NONE : new Set(ids));
  };
  read();
  const stopBoard = boards.current.subscribe(read);
  const stopLines = lines.subscribe(read);
  return () => {
    stopBoard();
    stopLines();
  };
}
