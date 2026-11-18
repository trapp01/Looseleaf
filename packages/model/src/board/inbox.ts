/**
 * The Inbox: the board's first lane, holding To Do lines that are waiting to
 * become cards. It is worked out from the line index, never stored.
 */
import type { TodoLine } from '../todo-lines.js';

/** A line in the Inbox, with the page it is on. */
export interface InboxLine {
  id: string;
  text: string;
  /** Epoch ms. */
  taggedAt: number;
  pageId: string;
  pageTitle: string;
}

export interface InboxInput {
  /** The board's `createdAt`. */
  createdAt: number;
  /** Each page's To Do lines, as `listTodoLines` reads them, by page id. */
  lines: ReadonlyMap<string, readonly TodoLine[]>;
  /** The pages that are cards (`cardPageIds`). */
  cardPageIds: ReadonlySet<string>;
  /** The notebook's live pages by id (`livePages`). A page not here is deleted or elsewhere. */
  livePages: ReadonlyMap<string, { title: string }>;
}

/**
 * The lines in the Inbox, newest first. A line is in it when it is unticked,
 * was tagged after the board was made, has not been kept as a line, and is
 * on a live page of the board's notebook that is not a card.
 */
export function inboxLines(input: InboxInput): InboxLine[] {
  const found: InboxLine[] = [];
  for (const [pageId, lines] of input.lines) {
    const page = input.livePages.get(pageId);
    if (page === undefined || input.cardPageIds.has(pageId)) continue;
    for (const line of lines) {
      if (line.id === null || line.checked || !line.inbox || line.taggedAt === null || line.taggedAt <= input.createdAt) continue;
      found.push({ id: line.id, text: line.text, taggedAt: line.taggedAt, pageId, pageTitle: page.title });
    }
  }
  return found.sort((a, b) => b.taggedAt - a.taggedAt || (a.id < b.id ? -1 : 1));
}
