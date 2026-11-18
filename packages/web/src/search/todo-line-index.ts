/**
 * Each page's To Do lines, as `listTodoLines` reads them, kept in memory for
 * card fronts' checklist counts and the Inbox. The search pass fills it as it
 * reads pages, and the open page writes its own lines as edits pause, so it
 * never opens a page doc itself. Lines of a page that is gone are dropped.
 */
import { useCallback, useSyncExternalStore } from 'react';
import type { TodoLine } from '@looseleaf/model';
import { Store } from '../app/store.js';

const NO_LINES: readonly TodoLine[] = [];

interface PageLines {
  notebookId: string;
  lines: readonly TodoLine[];
}

export class TodoLineIndex {
  private readonly pages = new Map<string, PageLines>();
  /** Bumped whenever any page's lines change. */
  readonly version = new Store(0);

  /** The page's lines in reading order; none for a page not read yet. */
  linesFor(pageId: string): readonly TodoLine[] {
    return this.pages.get(pageId)?.lines ?? NO_LINES;
  }

  /** Every page of the notebook that has been read, with its lines, by page id. */
  linesIn(notebookId: string): Map<string, readonly TodoLine[]> {
    const found = new Map<string, readonly TodoLine[]>();
    for (const [pageId, page] of this.pages) if (page.notebookId === notebookId) found.set(pageId, page.lines);
    return found;
  }

  /** Calls `listener` after any page's lines change. Returns the unsubscribe function. */
  subscribe(listener: () => void): () => void {
    return this.version.subscribe(listener);
  }

  /** Records a page's lines. Lines equal to those held already notify nobody. */
  set(pageId: string, notebookId: string, lines: readonly TodoLine[]): void {
    const held = this.pages.get(pageId);
    if (held && held.notebookId === notebookId && sameLines(held.lines, lines)) return;
    this.pages.set(pageId, { notebookId, lines });
    this.version.update((n) => n + 1);
  }

  /** Drops every page not in `live`. */
  keepOnly(live: ReadonlySet<string>): void {
    let dropped = false;
    for (const pageId of this.pages.keys()) {
      if (live.has(pageId)) continue;
      this.pages.delete(pageId);
      dropped = true;
    }
    if (dropped) this.version.update((n) => n + 1);
  }
}

function sameLines(a: readonly TodoLine[], b: readonly TodoLine[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((line, i) => {
    const other = b[i]!;
    return line.id === other.id && line.text === other.text && line.checked === other.checked && line.taggedAt === other.taggedAt && line.inbox === other.inbox;
  });
}

/** The page's To Do lines, re-rendering when they change. */
export function useTodoLines(index: TodoLineIndex, pageId: string): readonly TodoLine[] {
  const read = useCallback(() => index.linesFor(pageId), [index, pageId]);
  return useSyncExternalStore(index.version.subscribe, read, read);
}
