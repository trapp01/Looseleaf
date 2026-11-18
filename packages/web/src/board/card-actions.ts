/** Card actions started from more than one place (the card strip, the board, its shortcuts), each with its notice. */
import { archiveCard, formatCardRef, restoreCard, type Card } from '@looseleaf/model';
import { copyText } from '../app/clipboard.js';
import type { Services } from '../app/services.js';
import type { CurrentBoard } from './live-board.js';

/** Takes the card off the board and offers Undo, which restores it. Its page stays where it is. */
export function archiveWithUndo(services: Services, current: CurrentBoard, card: Card): void {
  const actor = services.actor.get();
  archiveCard(current.doc, card.id, actor);
  services.toasts.show(`Archived ${formatCardRef(current.board.meta.key, card.number)}`, () => restoreCard(current.doc, card.id, actor));
}

/** Copies a card ref such as `HOME-12` and says so; where copying is blocked the notice shows the ref instead. */
export async function copyCardRef(services: Services, ref: string): Promise<void> {
  const copied = await copyText(ref);
  services.toasts.show(copied ? `Copied ${ref}` : `Couldn’t copy. The ref is ${ref}.`);
}
