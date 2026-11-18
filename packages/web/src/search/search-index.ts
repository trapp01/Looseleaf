/**
 * The in-memory search index over every page's title and text. It fills in
 * the background one page at a time in idle time, re-reads a page whose
 * modified time changed, drops pages that are gone, and takes fresh text for
 * the open page directly. Queries run synchronously over the held text, so
 * they never wait on storage and never block typing for long. The same pass
 * keeps the To Do line index (todo-line-index.ts) filled.
 */
import { useCallback, useSyncExternalStore } from 'react';
import type { TodoLine } from '@looseleaf/model';
import { Store } from '../app/store.js';
import { TodoLineIndex } from './todo-line-index.js';

export interface SearchablePage {
  pageId: string;
  notebookId: string;
  sectionId: string;
  title: string;
  modifiedAt: number;
}

export interface SearchSource {
  /** Every live page in every notebook. */
  listPages(): SearchablePage[];
  /** The page's words, as `extractPageText` gives them, and its To Do lines, as `listTodoLines` gives them. */
  readPage(pageId: string): Promise<{ text: string; lines: TodoLine[] }>;
  /** Pages to read before the rest, asked again before each read: the open board's cards, whose fronts show their text and lines. */
  firstPages?(): ReadonlySet<string>;
}

export type SearchScope =
  | { kind: 'page'; pageId: string }
  | { kind: 'section'; sectionId: string }
  | { kind: 'notebook'; notebookId: string }
  | { kind: 'all' };

export interface Snippet {
  before: string;
  match: string;
  after: string;
}

export interface SearchHit {
  page: SearchablePage;
  titleMatch: boolean;
  /** Where the first query word occurs in the page text; null when only the title matches. */
  snippet: Snippet | null;
}

interface Indexed {
  modifiedAt: number;
  text: string;
  lower: string;
}

/** Waits for a moment the main thread is idle. */
export type IdleWait = () => Promise<void>;

export const idleWait: IdleWait = () =>
  new Promise((resolve) => {
    const ric = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
    if (ric) ric(() => resolve(), { timeout: 2000 });
    else setTimeout(resolve, 30);
  });

const SNIPPET_BEFORE = 40;
const SNIPPET_AFTER = 90;
export const MAX_HITS = 200;

export class SearchIndex {
  private readonly texts = new Map<string, Indexed>();
  private pages: SearchablePage[] = [];
  private running = false;
  private firstPassDone = false;
  private again = false;
  /** Pages indexed and pages known, for a progress note in the search pane. */
  readonly progress = new Store<{ indexed: number; total: number }>({ indexed: 0, total: 0 });
  /** Bumped whenever a page's held text changes. */
  readonly version = new Store(0);

  constructor(
    private readonly source: SearchSource,
    private readonly wait: IdleWait = idleWait,
    readonly lines: TodoLineIndex = new TodoLineIndex(),
  ) {}

  /** Re-reads the page list and indexes whatever is new or changed, in the background. Resolves when caught up. */
  async refresh(): Promise<void> {
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    try {
      do {
        this.again = false;
        await this.pass();
      } while (this.again);
    } finally {
      this.running = false;
    }
  }

  /** Takes the open page's current text without waiting for the background pass. */
  setPageText(pageId: string, text: string, modifiedAt: number): void {
    this.hold(pageId, text, modifiedAt);
  }

  /** The page's text as last read, or '' when it has not been read yet. */
  textOf(pageId: string): string {
    return this.texts.get(pageId)?.text ?? '';
  }

  /**
   * True once the page's text has been read, or once the first background
   * pass has finished, so '' from `textOf` means an empty page rather than
   * one still waiting to be read on first load. A page made since then is new
   * and empty until it is read.
   */
  hasRead(pageId: string): boolean {
    return this.firstPassDone || this.texts.has(pageId);
  }

  private hold(pageId: string, text: string, modifiedAt: number): void {
    const changed = this.texts.get(pageId)?.text !== text;
    this.texts.set(pageId, { modifiedAt, text, lower: text.toLowerCase() });
    if (changed) this.version.update((n) => n + 1);
  }

  search(query: string, scope: SearchScope): SearchHit[] {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return [];
    const hits: SearchHit[] = [];
    for (const page of this.pages) {
      if (!inScope(page, scope)) continue;
      const title = page.title.toLowerCase();
      const indexed = this.texts.get(page.pageId);
      const lower = indexed?.lower ?? '';
      if (!words.every((w) => title.includes(w) || lower.includes(w))) continue;
      const at = lower.indexOf(words[0]!);
      hits.push({
        page,
        titleMatch: words.every((w) => title.includes(w)),
        snippet: at >= 0 ? snippetAt(indexed!.text, at, words[0]!.length) : null,
      });
      if (hits.length >= MAX_HITS) break;
    }
    return hits.sort((a, b) => Number(b.titleMatch) - Number(a.titleMatch));
  }

  private async pass(): Promise<void> {
    this.pages = this.source.listPages();
    const live = new Set(this.pages.map((p) => p.pageId));
    for (const id of this.texts.keys()) if (!live.has(id)) this.texts.delete(id);
    this.lines.keepOnly(live);
    const stale = this.pages.filter((p) => this.texts.get(p.pageId)?.modifiedAt !== p.modifiedAt);
    this.report();
    while (stale.length > 0) {
      await this.wait();
      const first = this.source.firstPages?.();
      const at = first && first.size > 0 ? Math.max(0, stale.findIndex((p) => first.has(p.pageId))) : 0;
      const page = stale.splice(at, 1)[0]!;
      const known = this.texts.get(page.pageId);
      if (known && known.modifiedAt === page.modifiedAt) continue;
      try {
        const { text, lines } = await this.source.readPage(page.pageId);
        this.hold(page.pageId, text, page.modifiedAt);
        this.lines.set(page.pageId, page.notebookId, lines);
      } catch (error) {
        console.warn(`Search could not read page ${page.pageId}`, error);
        this.hold(page.pageId, '', page.modifiedAt);
      }
      this.report();
    }
    if (!this.firstPassDone) {
      this.firstPassDone = true;
      this.version.update((n) => n + 1);
    }
  }

  private report(): void {
    const indexed = this.pages.filter((p) => this.texts.has(p.pageId)).length;
    this.progress.update((p) => (p.indexed === indexed && p.total === this.pages.length ? p : { indexed, total: this.pages.length }));
  }
}

function inScope(page: SearchablePage, scope: SearchScope): boolean {
  switch (scope.kind) {
    case 'page':
      return page.pageId === scope.pageId;
    case 'section':
      return page.sectionId === scope.sectionId;
    case 'notebook':
      return page.notebookId === scope.notebookId;
    case 'all':
      return true;
  }
}

/** Text around a match, cut at word boundaries, whitespace collapsed. */
export function snippetAt(text: string, at: number, length: number): Snippet {
  let start = Math.max(0, at - SNIPPET_BEFORE);
  if (start > 0) {
    const space = text.indexOf(' ', start);
    if (space !== -1 && space < at) start = space + 1;
  }
  let end = Math.min(text.length, at + length + SNIPPET_AFTER);
  if (end < text.length) {
    const space = text.lastIndexOf(' ', end);
    if (space > at + length) end = space;
  }
  const tidy = (s: string) => s.replace(/\s+/g, ' ');
  return {
    before: (start > 0 ? '…' : '') + tidy(text.slice(start, at)).trimStart(),
    match: text.slice(at, at + length),
    after: tidy(text.slice(at + length, end)).trimEnd() + (end < text.length ? '…' : ''),
  };
}

export interface HitGroup {
  key: string;
  notebookId: string;
  sectionId: string;
  hits: SearchHit[];
}

/** Hits grouped by section, groups in the order their first hit appears. */
export function groupHits(hits: SearchHit[]): HitGroup[] {
  const groups = new Map<string, HitGroup>();
  for (const hit of hits) {
    const key = `${hit.page.notebookId}/${hit.page.sectionId}`;
    let group = groups.get(key);
    if (!group) {
      group = { key, notebookId: hit.page.notebookId, sectionId: hit.page.sectionId, hits: [] };
      groups.set(key, group);
    }
    group.hits.push(hit);
  }
  return [...groups.values()];
}

/** The page's text as search holds it, or null while it waits to be read on first load (see `hasRead`), re-rendering when either changes. */
export function usePageText(search: SearchIndex, pageId: string): string | null {
  const read = useCallback(() => (search.hasRead(pageId) ? search.textOf(pageId) : null), [search, pageId]);
  return useSyncExternalStore(search.version.subscribe, read, read);
}
