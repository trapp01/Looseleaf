/**
 * The strip under a card's page title: its ref, a status picker, its labels,
 * a button that copies the ref, its due day, the checklist count (the page's
 * To Do lines), a button that shows the Activity panel, a menu with Archive,
 * and whatever the page adds after them. It stands in for a card back; every
 * change goes straight to the board.
 */
import { useRef, useState, type ReactNode } from 'react';
import { ChatRegular, CheckboxCheckedRegular, CopyRegular, DismissRegular, MoreHorizontalRegular, TagRegular } from '@fluentui/react-icons';
import { cardLabels, checklistProgress, formatCardRef, moveCard, setCardDue, shownStatusId, type Card } from '@looseleaf/model';
import { useServices } from '../app/services.js';
import { showMenu } from '../nav/context-menu.js';
import { useTodoLines } from '../search/todo-line-index.js';
import { archiveWithUndo, copyCardRef } from './card-actions.js';
import { LabelChip } from './LabelChip.js';
import { LabelPicker } from './LabelPicker.js';
import type { CurrentBoard } from './live-board.js';

export function CardStrip({
  current,
  card,
  activityOpen,
  onToggleActivity,
  children,
}: {
  current: CurrentBoard;
  card: Card;
  activityOpen: boolean;
  onToggleActivity: () => void;
  children?: ReactNode;
}) {
  const services = useServices();
  const { actor, todoLines } = services;
  const { doc, board } = current;
  const statusId = shownStatusId(board, card);
  const labels = cardLabels(board, card);
  const progress = checklistProgress(useTodoLines(todoLines, card.id));
  const labelButton = useRef<HTMLButtonElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const [labelsOpen, setLabelsOpen] = useState(false);
  const ref = formatCardRef(board.meta.key, card.number);
  const talk = card.comments.length;

  const openMenu = () => {
    const r = menuButton.current!.getBoundingClientRect();
    showMenu(r.left, r.bottom + 4, [{ label: 'Archive', onSelect: () => archiveWithUndo(services, current, card) }]);
  };

  return (
    <div className="card-strip" role="group" aria-label={`Card ${ref}`}>
      <span className="card-ref">{ref}</span>
      <button type="button" className="strip-icon" aria-label="Copy ref" title={`Copy ${ref}`} onClick={() => void copyCardRef(services, ref)}>
        <CopyRegular />
      </button>
      <select
        className="strip-select"
        aria-label="Status"
        value={statusId ?? ''}
        onChange={(e) => moveCard(doc, card.id, { statusId: e.target.value, place: 'bottom' }, actor.get())}
      >
        {statusId === null && <option value="">Archived status</option>}
        {board.statuses.map((option) => (
          <option key={option.id} value={option.id}>
            {option.name}
          </option>
        ))}
      </select>
      <button
        ref={labelButton}
        type="button"
        className="strip-button strip-labels"
        aria-label={labels.length === 0 ? 'Add labels' : `Labels: ${labels.map((l) => l.name).join(', ')}`}
        aria-expanded={labelsOpen}
        onClick={() => setLabelsOpen((open) => !open)}
      >
        {labels.length === 0 ? (
          <>
            <TagRegular aria-hidden="true" />
            Labels
          </>
        ) : (
          labels.map((label) => <LabelChip key={label.id} label={label} small />)
        )}
      </button>
      <span className="strip-due">
        <input type="date" aria-label="Due day" value={card.due ?? ''} onChange={(e) => setCardDue(doc, card.id, e.target.value || null)} />
        {card.due !== null && (
          <button type="button" className="strip-icon" aria-label="Clear due day" title="Clear due day" onClick={() => setCardDue(doc, card.id, null)}>
            <DismissRegular />
          </button>
        )}
      </span>
      {progress.total > 0 && (
        <span className={`strip-count ${progress.done === progress.total ? 'is-complete' : ''}`} title={`Checklist: ${progress.done} of ${progress.total} done`}>
          <CheckboxCheckedRegular aria-hidden="true" />
          {progress.done}/{progress.total}
        </span>
      )}
      <button type="button" className={`strip-button ${activityOpen ? 'is-active' : ''}`} aria-pressed={activityOpen} onClick={onToggleActivity}>
        <ChatRegular aria-hidden="true" />
        Activity{talk > 0 ? ` (${talk})` : ''}
      </button>
      <button ref={menuButton} type="button" className="strip-icon" aria-label="Card actions" title="Card actions" aria-haspopup="menu" onClick={openMenu}>
        <MoreHorizontalRegular />
      </button>
      {children}
      {labelsOpen && <LabelPicker current={current} card={card} anchor={labelButton.current} onClose={() => setLabelsOpen(false)} />}
    </div>
  );
}
