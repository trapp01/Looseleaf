import { describe, expect, it, vi } from 'vitest';
import type { TodoLine } from '@looseleaf/model';
import { SearchIndex, type SearchablePage } from '../src/search/search-index.js';
import { TodoLineIndex } from '../src/search/todo-line-index.js';

const line = (text: string, checked = false): TodoLine => ({ id: `id-${text}`, text, checked, taggedAt: 10, inbox: true });

const page = (pageId: string, notebookId: string, modifiedAt = 1): SearchablePage => ({ pageId, notebookId, sectionId: 's', title: pageId, modifiedAt });

describe('TodoLineIndex', () => {
  it('answers by page and by notebook and notifies only on a real change', () => {
    const index = new TodoLineIndex();
    const listener = vi.fn();
    index.subscribe(listener);
    index.set('a', 'n1', [line('Buy seeds')]);
    index.set('b', 'n2', [line('Mend the gate', true)]);
    expect(listener).toHaveBeenCalledTimes(2);
    index.set('a', 'n1', [line('Buy seeds')]);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(index.linesFor('a').map((l) => l.text)).toEqual(['Buy seeds']);
    expect(index.linesFor('missing')).toEqual([]);
    expect([...index.linesIn('n2').keys()]).toEqual(['b']);
    index.set('a', 'n1', [line('Buy seeds', true)]);
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it('is filled by the search pass and drops pages that are gone', async () => {
    const pages = [page('a', 'n1'), page('b', 'n1')];
    const lines: Record<string, TodoLine[]> = { a: [line('Prune the roses')], b: [] };
    const source = { listPages: () => pages, readPage: async (id: string) => ({ text: '', lines: lines[id] ?? [] }) };
    const search = new SearchIndex(source, async () => undefined);
    await search.refresh();
    expect(search.lines.linesFor('a').map((l) => l.text)).toEqual(['Prune the roses']);
    pages.splice(0, 1);
    await search.refresh();
    expect(search.lines.linesFor('a')).toEqual([]);
    expect([...search.lines.linesIn('n1').keys()]).toEqual(['b']);
  });

  it('bumps the search version only when a page text changes', async () => {
    const search = new SearchIndex({ listPages: () => [page('a', 'n1')], readPage: async () => ({ text: 'Seed list', lines: [] }) }, async () => undefined);
    await search.refresh();
    const before = search.version.get();
    expect(search.textOf('a')).toBe('Seed list');
    search.setPageText('a', 'Seed list', 2);
    expect(search.version.get()).toBe(before);
    search.setPageText('a', 'Seed list and bulbs', 3);
    expect(search.version.get()).toBe(before + 1);
  });
});
