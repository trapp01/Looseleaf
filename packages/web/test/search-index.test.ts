import { describe, expect, it } from 'vitest';
import { groupHits, SearchIndex, snippetAt, type SearchablePage } from '../src/search/search-index.js';

function source(pages: SearchablePage[], texts: Record<string, string>) {
  const src = {
    reads: [] as string[],
    pages,
    texts,
    listPages: () => src.pages,
    readPage: async (id: string) => {
      src.reads.push(id);
      return { text: src.texts[id] ?? '', lines: [] };
    },
  };
  return src;
}

const page = (pageId: string, title: string, sectionId = 's1', notebookId = 'n1', modifiedAt = 1): SearchablePage => ({
  pageId,
  title,
  sectionId,
  notebookId,
  modifiedAt,
});

const now = async () => undefined;

describe('SearchIndex', () => {
  it('finds pages by title and by text, title matches first, with a snippet around the match', async () => {
    const src = source([page('a', 'Groceries'), page('b', 'Cell biology')], { a: 'milk and bread', b: 'The cell membrane and the nucleus' });
    const index = new SearchIndex(src, now);
    await index.refresh();
    const hits = index.search('cell', { kind: 'all' });
    expect(hits.map((h) => h.page.pageId)).toEqual(['b']);
    expect(hits[0]!.titleMatch).toBe(true);
    expect(hits[0]!.snippet).toEqual({ before: 'The ', match: 'cell', after: ' membrane and the nucleus' });
    expect(index.search('BREAD milk', { kind: 'all' }).map((h) => h.page.pageId)).toEqual(['a']);
    expect(index.search('bread nucleus', { kind: 'all' })).toEqual([]);
  });

  it('limits results to the page, section or notebook in scope', async () => {
    const src = source([page('a', 'One', 's1', 'n1'), page('b', 'Two', 's2', 'n1'), page('c', 'Three', 's3', 'n2')], {
      a: 'shared word',
      b: 'shared word',
      c: 'shared word',
    });
    const index = new SearchIndex(src, now);
    await index.refresh();
    expect(index.search('shared', { kind: 'all' })).toHaveLength(3);
    expect(index.search('shared', { kind: 'notebook', notebookId: 'n1' }).map((h) => h.page.pageId)).toEqual(['a', 'b']);
    expect(index.search('shared', { kind: 'section', sectionId: 's2' }).map((h) => h.page.pageId)).toEqual(['b']);
    expect(index.search('shared', { kind: 'page', pageId: 'c' }).map((h) => h.page.pageId)).toEqual(['c']);
  });

  it('re-reads only pages whose modified time changed and drops pages that are gone', async () => {
    const src = source([page('a', 'A', 's1', 'n1', 1), page('b', 'B', 's1', 'n1', 1)], { a: 'old text', b: 'bee' });
    const index = new SearchIndex(src, now);
    await index.refresh();
    expect(src.reads.sort()).toEqual(['a', 'b']);
    src.texts.a = 'new text';
    src.pages = [page('a', 'A', 's1', 'n1', 2)];
    src.reads.length = 0;
    await index.refresh();
    expect(src.reads).toEqual(['a']);
    expect(index.search('new', { kind: 'all' })).toHaveLength(1);
    expect(index.search('bee', { kind: 'all' })).toEqual([]);
    expect(index.progress.get()).toEqual({ indexed: 1, total: 1 });
  });

  it('takes the open page text directly', async () => {
    const index = new SearchIndex(source([page('a', 'A')], { a: '' }), now);
    await index.refresh();
    index.setPageText('a', 'typed just now', 1);
    expect(index.search('typed', { kind: 'all' })).toHaveLength(1);
  });

  it('indexes 4,000 pages and answers a query quickly', async () => {
    const pages = Array.from({ length: 4000 }, (_, i) => page(`p${i}`, `Page ${i}`, `s${i % 40}`));
    const texts = Object.fromEntries(pages.map((p, i) => [p.pageId, `paragraph ${i} `.repeat(200) + (i === 3999 ? 'needle' : '')]));
    const index = new SearchIndex(source(pages, texts), now);
    await index.refresh();
    const started = performance.now();
    const hits = index.search('needle', { kind: 'all' });
    expect(performance.now() - started).toBeLessThan(200);
    expect(hits.map((h) => h.page.pageId)).toEqual(['p3999']);
  });
});

describe('snippets and groups', () => {
  it('cuts long text at word boundaries with ellipses', () => {
    const text = `${'lorem ipsum '.repeat(10)}target${' dolor sit'.repeat(20)}`;
    const s = snippetAt(text, text.indexOf('target'), 6);
    expect(s.match).toBe('target');
    expect(s.before.startsWith('…')).toBe(true);
    expect(s.after.endsWith('…')).toBe(true);
    expect(s.before).toMatch(/^…(lorem|ipsum) /);
  });

  it('groups hits by section in first-seen order', () => {
    const hit = (id: string, section: string) => ({ page: page(id, id, section), titleMatch: false, snippet: null });
    expect(groupHits([hit('a', 's2'), hit('b', 's1'), hit('c', 's2')]).map((g) => [g.sectionId, g.hits.map((h) => h.page.pageId)])).toEqual([
      ['s2', ['a', 'c']],
      ['s1', ['b']],
    ]);
  });
});
