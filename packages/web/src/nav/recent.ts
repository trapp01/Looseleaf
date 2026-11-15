/** Recently opened pages, newest first, remembered per device. */
import { readLocal, writeLocal } from '../app/local-settings.js';
import { Store } from '../app/store.js';

export interface RecentPage {
  notebookId: string;
  sectionId: string;
  pageId: string;
  at: number;
}

const KEY = 'recentPages';
const LIMIT = 30;

export class RecentPages extends Store<RecentPage[]> {
  constructor() {
    super(readLocal<RecentPage[]>(KEY, []));
  }

  visit(page: Omit<RecentPage, 'at'>): void {
    if (this.get()[0]?.pageId === page.pageId) return;
    const next = [{ ...page, at: Date.now() }, ...this.get().filter((p) => p.pageId !== page.pageId)].slice(0, LIMIT);
    this.set(next);
    writeLocal(KEY, next);
  }
}
