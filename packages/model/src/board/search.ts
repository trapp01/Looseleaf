/** Finding cards on a board by words and by status, label and due day. */
import { cardLabels, shownStatusId, type BoardSnapshot, type Card } from './board.js';

export interface CardFilter {
  /** Words separated by spaces; a card matches when every word is in its title, page, labels, comments or links. */
  query?: string;
  statusId?: string;
  labelId?: string;
  /** Only cards due on or before this day (`YYYY-MM-DD`). */
  dueBy?: string;
  /** Archived cards are left out unless this is true. */
  includeArchived?: boolean;
}

function words(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter((word) => word !== '');
}

function searchText(board: BoardSnapshot, card: Card, pageText: string): string {
  return [
    pageText,
    ...cardLabels(board, card).map((label) => label.name),
    ...card.comments.map((comment) => comment.body),
    ...card.links.map((link) => `${link.title} ${link.target}`),
  ]
    .join('\n')
    .toLowerCase();
}

function occurrences(text: string, word: string): number {
  let count = 0;
  for (let at = text.indexOf(word); at !== -1; at = text.indexOf(word, at + word.length)) count++;
  return count;
}

/**
 * The cards that pass the filter. `pageText` holds each card's page text by
 * page id (`extractPageText`); a card without an entry is searched without it.
 * With a query, cards with every word in the title come first, then cards
 * with more occurrences; without one, the most recently changed come first.
 */
export function searchCards(board: BoardSnapshot, filter: CardFilter, pageText: ReadonlyMap<string, string> = new Map()): Card[] {
  const wanted = words(filter.query ?? '');
  const scored: Array<{ card: Card; inTitle: boolean; count: number }> = [];
  for (const card of board.cards) {
    const shown = card.archivedAt === null && shownStatusId(board, card) !== null;
    if (!shown && filter.includeArchived !== true) continue;
    if (filter.statusId !== undefined && card.statusId !== filter.statusId) continue;
    if (filter.labelId !== undefined && !card.labelIds.includes(filter.labelId)) continue;
    if (filter.dueBy !== undefined && (card.due === null || card.due > filter.dueBy)) continue;
    const title = card.title.toLowerCase();
    const rest = wanted.length === 0 ? '' : searchText(board, card, pageText.get(card.id) ?? '');
    if (!wanted.every((word) => title.includes(word) || rest.includes(word))) continue;
    scored.push({
      card,
      inTitle: wanted.length > 0 && wanted.every((word) => title.includes(word)),
      count: wanted.reduce((sum, word) => sum + occurrences(title, word) + occurrences(rest, word), 0),
    });
  }
  return scored
    .sort((a, b) => Number(b.inTitle) - Number(a.inTitle) || b.count - a.count || b.card.updatedAt - a.card.updatedAt)
    .map((entry) => entry.card);
}
