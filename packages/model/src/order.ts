import { generateNKeysBetween } from 'fractional-indexing';

/** Anything placed among siblings: a notebook or a node. */
export interface Ordered {
  id: string;
  order: string;
}

/** Sorts siblings by `order`, then by id, without changing the input. */
export function sortByOrder<T extends Ordered>(siblings: readonly T[]): T[] {
  return [...siblings].sort(compareOrder);
}

function compareOrder(a: Ordered, b: Ordered): number {
  if (a.order !== b.order) return a.order < b.order ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

/**
 * The order string for an item inserted at `index` among `siblings`, which
 * must already be sorted and must not contain the item itself. An index past
 * the end appends. When the neighbours share an order string (two replicas
 * inserted at the same spot), the item goes after every sibling with that
 * string, since nothing fits strictly between equal strings.
 */
export function orderAt(siblings: readonly Ordered[], index: number): string {
  return ordersAt(siblings, index, 1)[0]!;
}

/** Like `orderAt`, for `count` items inserted together; the strings come back ascending. */
export function ordersAt(siblings: readonly Ordered[], index: number, count: number): string[] {
  const at = Math.max(0, Math.min(index, siblings.length));
  const before = at > 0 ? siblings[at - 1]!.order : null;
  let next = at;
  while (before !== null && next < siblings.length && siblings[next]!.order <= before) next++;
  const after = next < siblings.length ? siblings[next]!.order : null;
  return generateNKeysBetween(before, after, count);
}
