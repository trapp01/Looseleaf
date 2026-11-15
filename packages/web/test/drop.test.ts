import { describe, expect, it } from 'vitest';
import type { PageEntry } from '@looseleaf/model';
import { dropPosition, indexAmong, pageBlock } from '../src/nav/drop.js';

const p = (id: string, level: 0 | 1 | 2): PageEntry => ({ id, title: id, level, createdAt: 0, modifiedAt: 0 });

describe('drag and drop', () => {
  it('splits a row into before, into and after', () => {
    expect(dropPosition(2, 36, true)).toBe('before');
    expect(dropPosition(18, 36, true)).toBe('into');
    expect(dropPosition(34, 36, true)).toBe('after');
    expect(dropPosition(18, 36, false)).toBe('after');
  });

  it('counts the index among siblings once the moved nodes are out', () => {
    expect(indexAmong(['a', 'b', 'c', 'd'], new Set(['a']), 'c', 'after')).toBe(2);
    expect(indexAmong(['a', 'b', 'c', 'd'], new Set(['d']), 'a', 'before')).toBe(0);
    expect(indexAmong(['a', 'b'], new Set(['a']), 'a', 'after')).toBe(null);
  });

  it('moves a page with its subpages', () => {
    const pages = [p('a', 0), p('a1', 1), p('a2', 2), p('b', 0), p('b1', 1)];
    expect([...pageBlock(pages, 'a')]).toEqual(['a', 'a1', 'a2']);
    expect([...pageBlock(pages, 'a1')]).toEqual(['a1', 'a2']);
    expect([...pageBlock(pages, 'b1')]).toEqual(['b1']);
    expect(indexAmong(pages.map((x) => x.id), pageBlock(pages, 'a'), 'b1', 'after')).toBe(2);
  });
});
