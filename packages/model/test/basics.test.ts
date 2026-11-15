import { describe, expect, it } from 'vitest';
import {
  COLORS,
  LIBRARY_DOC_ID,
  colorHex,
  isColorName,
  nearestColor,
  newId,
  notebookDocId,
  orderAt,
  pageDocId,
  sortByOrder,
} from '../src/index.js';

describe('ids', () => {
  it('makes 21-character url-safe ids', () => {
    const ids = new Set(Array.from({ length: 200 }, newId));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{21}$/);
  });

  it('names docs as the architecture lays out', () => {
    expect(LIBRARY_DOC_ID).toBe('library');
    expect(notebookDocId('abc')).toBe('nb:abc');
    expect(pageDocId('xyz')).toBe('pg:xyz');
  });
});

describe('ordering', () => {
  it('sorts by order then id', () => {
    const sorted = sortByOrder([
      { id: 'b', order: 'a1' },
      { id: 'a', order: 'a1' },
      { id: 'c', order: 'a0' },
    ]);
    expect(sorted.map((s) => s.id)).toEqual(['c', 'a', 'b']);
  });

  it('inserts at the start, middle and end without touching siblings', () => {
    let list = [{ id: 'x', order: orderAt([], 0) }];
    list = sortByOrder([...list, { id: 'end', order: orderAt(list, 5) }]);
    list = sortByOrder([...list, { id: 'start', order: orderAt(list, 0) }]);
    list = sortByOrder([...list, { id: 'mid', order: orderAt(list, 2) }]);
    expect(list.map((s) => s.id)).toEqual(['start', 'x', 'mid', 'end']);
  });

  it('stays stable over many inserts at one spot', () => {
    let list: Array<{ id: string; order: string }> = [];
    for (let i = 0; i < 100; i++) list = sortByOrder([...list, { id: `n${i}`, order: orderAt(list, 1) }]);
    expect(list[0]!.id).toBe('n0');
    expect(list[list.length - 1]!.id).toBe('n1');
    expect(new Set(list.map((s) => s.order)).size).toBe(100);
  });

  it('places an item after siblings that share an order string', () => {
    const list = sortByOrder([
      { id: 'a', order: 'a0' },
      { id: 'b', order: 'a0' },
      { id: 'c', order: 'a1' },
    ]);
    const order = orderAt(list, 1);
    const result = sortByOrder([...list, { id: 'new', order }]);
    expect(result.map((s) => s.id)).toEqual(['a', 'b', 'new', 'c']);
  });
});

describe('colours', () => {
  it('has 16 distinct names with hex values', () => {
    expect(COLORS).toHaveLength(16);
    expect(new Set(COLORS.map((c) => c.name)).size).toBe(16);
    for (const c of COLORS) expect(c.hex).toMatch(/^#[0-9a-f]{6}$/);
    expect(colorHex('teal')).toBe('#2a9d8f');
    expect(isColorName('teal')).toBe(true);
    expect(isColorName('Blue Mist')).toBe(false);
  });

  it('maps a hex value to the nearest palette colour', () => {
    expect(nearestColor('#d1495b')).toBe('red');
    expect(nearestColor('#3a7cd7')).toBe('blue');
    expect(nearestColor('not a colour')).toBe('blue');
  });
});
