/** Which cards the label filter and the board's search box leave showing on a board. */
import { useMemo } from 'react';
import { searchCards, type BoardSnapshot } from '@looseleaf/model';
import { useServices } from '../app/services.js';
import { useStore } from '../app/store.js';

/**
 * The ids of the cards that carry any one of `labelIds` and have every word
 * of `query` (see model's `searchCards`; `textOf` gives a card's page text),
 * or null when neither is set and every card shows.
 */
export function matchingCardIds(
  board: BoardSnapshot,
  labelIds: readonly string[],
  query = '',
  textOf: (pageId: string) => string = () => '',
): Set<string> | null {
  if (labelIds.length === 0 && query.trim() === '') return null;
  const labels = new Set(labelIds);
  const pageText = new Map(query.trim() === '' ? [] : board.cards.map((card) => [card.id, textOf(card.id)]));
  const ids = new Set<string>();
  for (const card of searchCards(board, { query }, pageText)) {
    if (labels.size > 0 && !card.labelIds.some((id) => labels.has(id))) continue;
    ids.add(card.id);
  }
  return ids;
}

/** The chosen labels that still exist on the board, so a deleted label cannot hide every card. */
export function liveLabelFilter(board: BoardSnapshot, labelIds: string[]): string[] {
  const kept = labelIds.filter((id) => board.labels.some((label) => label.id === id));
  return kept.length === labelIds.length ? labelIds : kept;
}

/** The board's filter as the UI state holds it, and the cards it leaves showing (null for every card). */
export function useCardFilter(board: BoardSnapshot): { labelIds: string[]; query: string; matches: Set<string> | null } {
  const { ui, search } = useServices();
  const state = useStore(ui);
  const labelIds = liveLabelFilter(board, state.boardLabels);
  const query = state.boardQuery;
  // Page text only matters while there is a query; re-reading it on every text change otherwise is wasted work.
  const textVersion = useStore(search.version);
  const version = query.trim() === '' ? 0 : textVersion;
  const matches = useMemo(() => matchingCardIds(board, labelIds, query, (pageId) => search.textOf(pageId)), [board, labelIds, query, search, version]);
  return { labelIds, query, matches };
}
