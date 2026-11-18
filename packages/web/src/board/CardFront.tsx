/**
 * A card as it sits in a status: its labels, its title (the page title), the
 * first lines of the page, and a quiet row with the card ref, the due day,
 * the checklist count (the page's To Do lines) and counts of comments and
 * links. A card in a `done` status reads as finished. The whole card opens
 * its page (see open-page.ts) and doubles as the drag handle.
 */
import type { HTMLAttributes, MouseEvent } from 'react';
import { CalendarLtrRegular, CheckboxCheckedRegular, CheckmarkCircleFilled, CommentRegular, LinkRegular } from '@fluentui/react-icons';
import { checklistProgress, formatCardRef, pageHash, type Card, type Label, type StatusKind } from '@looseleaf/model';
import { useServices } from '../app/services.js';
import { usePageText } from '../search/search-index.js';
import { useTodoLines } from '../search/todo-line-index.js';
import { dueState, shortDay, todayDay } from './due.js';
import { LabelChip } from './LabelChip.js';
import { openPage } from './open-page.js';

/** How much of the page's text a card front shows; CSS clamps it to three lines. */
const EXCERPT_CHARS = 240;

export function CardFront({
  card,
  labels,
  boardKey,
  kind,
  flashing = false,
  overlay = false,
  open = false,
  dragHandle,
}: {
  card: Card;
  labels: Label[];
  boardKey: string;
  kind: StatusKind | null;
  flashing?: boolean;
  /** Drawn under the pointer while dragging. */
  overlay?: boolean;
  /** Its page is the one open beside the board. */
  open?: boolean;
  dragHandle?: HTMLAttributes<HTMLElement>;
}) {
  const services = useServices();
  const { search, todoLines } = services;
  const ref = formatCardRef(boardKey, card.number);
  const today = todayDay();
  const due = dueState(card.due, today, kind);
  const progress = checklistProgress(useTodoLines(todoLines, card.id));
  const text = usePageText(search, card.id);
  const excerpt = (text ?? '').slice(0, EXCERPT_CHARS).trim();
  const done = kind === 'done';
  const onClick = (event: MouseEvent) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    openPage(services, card.id);
  };
  return (
    <a
      {...dragHandle}
      href={pageHash(card.id)}
      onClick={onClick}
      className={`card-front ${done ? 'is-done' : ''} ${flashing ? 'is-flashing' : ''} ${overlay ? 'is-overlay' : ''} ${open ? 'is-open' : ''}`}
      aria-current={open ? 'page' : undefined}
      data-card-id={card.id}
    >
      {labels.length > 0 && (
        <span className="card-labels">
          {labels.map((label) => (
            <LabelChip key={label.id} label={label} small />
          ))}
        </span>
      )}
      <span className="card-title">
        {done && <CheckmarkCircleFilled className="card-done-mark" aria-hidden="true" />}
        {done && <span className="visually-hidden">Finished: </span>}
        {card.title || 'Untitled page'}
      </span>
      {excerpt !== '' ? (
        <span className="card-excerpt">{excerpt}</span>
      ) : (
        // Until the background pass reads the page, a placeholder holds the excerpt's first line so the board does not jump.
        text === null && <span className="card-excerpt is-pending" aria-hidden="true" />
      )}
      <span className="card-meta">
        <span className="card-ref">{ref}</span>
        {card.due !== null && (
          <span className={`badge due-${due}`} title={due === 'overdue' ? `Overdue, was due ${card.due}` : `Due ${card.due}`}>
            <CalendarLtrRegular aria-hidden="true" />
            {shortDay(card.due, today)}
            {due === 'overdue' && <span className="visually-hidden"> (overdue)</span>}
          </span>
        )}
        {progress.total > 0 && (
          <span className={`badge ${progress.done === progress.total ? 'is-complete' : ''}`} title={`Checklist: ${progress.done} of ${progress.total} done`}>
            <CheckboxCheckedRegular aria-hidden="true" />
            {progress.done}/{progress.total}
          </span>
        )}
        <Count icon={<CommentRegular aria-hidden="true" />} count={card.comments.length} noun="comment" />
        <Count icon={<LinkRegular aria-hidden="true" />} count={card.links.length} noun="link" />
      </span>
    </a>
  );
}

function Count({ icon, count, noun }: { icon: JSX.Element; count: number; noun: string }) {
  if (count === 0) return null;
  const label = count === 1 ? `1 ${noun}` : `${count} ${noun}s`;
  return (
    <span className="badge" title={label}>
      {icon}
      {count}
      <span className="visually-hidden"> {count === 1 ? noun : `${noun}s`}</span>
    </span>
  );
}
