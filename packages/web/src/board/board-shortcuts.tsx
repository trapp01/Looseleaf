/**
 * The board's single-key shortcuts, live while a board shows (the board view
 * or the board beside a page): `n` adds a card to the status under the
 * pointer (or the first), `/` focuses the board's search box, `?` lists the
 * shortcuts, and on the card under the pointer or in focus Enter opens it and
 * `c` archives it. None fire while typing in a field or the page, with a
 * modifier held, or while a dialog, popover or menu is open, so they never
 * meet Looseleaf's own shortcuts, which all take a modifier.
 */
import { useEffect, useRef } from 'react';
import { Dialog } from '../app/controls.js';
import { useServices, type Services } from '../app/services.js';
import { Store } from '../app/store.js';
import { patchUi } from '../app/ui-state.js';
import { archiveWithUndo } from './card-actions.js';
import type { CurrentBoard } from './live-board.js';
import { openPage } from './open-page.js';

export const SHORTCUTS: ReadonlyArray<{ keys: string; does: string }> = [
  { keys: 'n', does: 'Add a card to the status under the pointer, or the first status' },
  { keys: '/', does: 'Search the cards on this board' },
  { keys: 'Enter', does: 'Open the card under the pointer or in focus' },
  { keys: 'c', does: 'Archive the card under the pointer or in focus' },
  { keys: '?', does: 'Show these shortcuts' },
  { keys: 'Esc', does: 'Close the page beside the board' },
];

/** The status and card under the pointer, for the `n`, Enter and `c` shortcuts. Status columns and cards set it. */
export const boardHover = new Store<{ statusId: string | null; cardId: string | null }>({ statusId: null, cardId: null });

export function isTyping(target: EventTarget | null): boolean {
  return !!(target as HTMLElement | null)?.closest?.('input, textarea, select, [contenteditable="true"]');
}

/** True while a dialog, popover or menu is open; Escape and the shortcuts belong to it then. */
export function layerOpen(): boolean {
  return document.querySelector('.dialog-backdrop, .popover, .context-menu') !== null;
}

/** The card under the pointer, else the card holding focus. */
function targetCardId(): string | null {
  const focused = (document.activeElement as HTMLElement | null)?.closest?.<HTMLElement>('[data-card-id]');
  return boardHover.get().cardId ?? focused?.dataset.cardId ?? null;
}

function runShortcut(services: Services, board: CurrentBoard, event: KeyboardEvent): boolean {
  switch (event.key) {
    case '/':
      patchUi(services.ui, { focusBoardSearch: services.ui.get().focusBoardSearch + 1 });
      return true;
    case '?':
      patchUi(services.ui, { dialog: { kind: 'board-shortcuts' } });
      return true;
    case 'n': {
      const statusId = boardHover.get().statusId ?? board.board.statuses[0]?.id ?? null;
      if (statusId) patchUi(services.ui, { composer: statusId });
      return statusId !== null;
    }
    case 'Enter':
    case 'c': {
      // Enter on a focused button or link that is not a card presses it.
      const focused = document.activeElement as HTMLElement | null;
      if (event.key === 'Enter' && focused?.closest('button, a, [role="button"]') && !focused.closest('[data-card-id]')) return false;
      const cardId = targetCardId();
      const card = cardId ? board.board.cards.find((candidate) => candidate.id === cardId) : undefined;
      if (!card || card.archivedAt !== null) return false;
      if (event.key === 'Enter') openPage(services, card.id);
      else {
        boardHover.set({ ...boardHover.get(), cardId: null });
        archiveWithUndo(services, board, card);
      }
      return true;
    }
  }
  return false;
}

export function useBoardShortcuts(current: CurrentBoard): void {
  const services = useServices();
  const latest = useRef(current);
  latest.current = current;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTyping(event.target) || layerOpen()) return;
      if (runShortcut(services, latest.current, event)) event.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [services]);
}

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog title="Keyboard shortcuts" onClose={onClose}>
      <dl className="shortcut-list">
        {SHORTCUTS.map((shortcut) => (
          <div key={shortcut.keys} className="shortcut-row">
            <dt>
              <kbd>{shortcut.keys}</kbd>
            </dt>
            <dd>{shortcut.does}</dd>
          </div>
        ))}
      </dl>
      <p className="muted small">
        Shortcuts don’t fire while you type in a field or on the page. To drag with the keyboard, focus a card, a line in the Inbox or a status header,
        press Space to lift it, move it with the arrow keys, and press Space again to drop it.
      </p>
    </Dialog>
  );
}
