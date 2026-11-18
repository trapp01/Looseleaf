/** Telling which cards a change from elsewhere (an agent, another device) touched, so they can flash. */
import type { BoardSnapshot, Card } from '@looseleaf/model';

/** The ids of cards that are new in `after` or differ from their copy in `before`. */
export function changedCardIds(before: BoardSnapshot, after: BoardSnapshot): string[] {
  const previous = new Map<string, Card>(before.cards.map((card) => [card.id, card]));
  const changed: string[] = [];
  for (const card of after.cards) {
    const old = previous.get(card.id);
    if (old === undefined || JSON.stringify(old) !== JSON.stringify(card)) changed.push(card.id);
  }
  return changed;
}
