/**
 * The board's archived statuses and cards, each with Restore. A card hidden
 * because its status is archived comes back with that status, so it is listed
 * under the status rather than restorable on its own.
 */
import { useState } from 'react';
import { archivedCards, formatCardRef, restoreCard, restoreStatus, shownStatusId } from '@looseleaf/model';
import { Dialog } from '../app/controls.js';
import { useServices } from '../app/services.js';
import { describeTime } from '../sync-ui/status-label.js';
import { fullTime } from './due.js';
import { KindMarker } from './KindMarker.js';
import type { CurrentBoard } from './live-board.js';

export function ArchiveDialog({ current, onClose }: { current: CurrentBoard; onClose: () => void }) {
  const { actor } = useServices();
  const { doc, board } = current;
  const [now] = useState(() => Date.now());
  const cards = archivedCards(board).filter((card) => card.archivedAt !== null);
  const statuses = board.archivedStatuses;
  const hiddenIn = (statusId: string) => board.cards.filter((card) => card.statusId === statusId && card.archivedAt === null).length;

  return (
    <Dialog title="Archived items" onClose={onClose}>
      {statuses.length === 0 && cards.length === 0 && <p className="muted">Nothing on this board is archived.</p>}
      {statuses.length > 0 && (
        <section className="archive-section">
          <h3>Statuses</h3>
          <ul className="archive-list">
            {statuses.map((status) => (
              <li key={status.id} className="archive-row">
                <KindMarker kind={status.kind} />
                <span className="archive-name">{status.name}</span>
                <span className="muted small">{hiddenIn(status.id) === 1 ? '1 card' : `${hiddenIn(status.id)} cards`}</span>
                <span className="spacer" />
                <button type="button" className="button" onClick={() => restoreStatus(doc, status.id)}>
                  Restore
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {cards.length > 0 && (
        <section className="archive-section">
          <h3>Cards</h3>
          <ul className="archive-list">
            {cards.map((card) => (
              <li key={card.id} className="archive-row">
                <span className="card-ref">{formatCardRef(board.meta.key, card.number)}</span>
                <span className="archive-name">{card.title || 'Untitled page'}</span>
                <time className="muted small" title={fullTime(card.archivedAt!)}>
                  {describeTime(card.archivedAt, now)}
                </time>
                <span className="spacer" />
                {shownStatusId(board, card) === null ? (
                  <span className="muted small">Its status is archived</span>
                ) : (
                  <button type="button" className="button" onClick={() => restoreCard(doc, card.id, actor.get())}>
                    Restore
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </Dialog>
  );
}
