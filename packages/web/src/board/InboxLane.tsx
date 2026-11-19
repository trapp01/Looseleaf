/**
 * The Inbox: the board's first lane, before the statuses and pinned at the
 * board's left edge while they scroll sideways (not on a phone, where it is
 * simply the first column). It lists the To Do
 * lines waiting to become cards, newest first, each with a tick box (which
 * ticks the line on its page), its text, the page it is on (which opens that
 * page) and a menu. A line drags into a status to become a card there; the
 * lane itself takes no drops and has no order of its own. With no lines it
 * is not shown, and the statuses start at the board's left edge.
 */
import { useDraggable } from '@dnd-kit/core';
import { DocumentRegular, MailInboxRegular, MoreHorizontalRegular } from '@fluentui/react-icons';
import type { InboxLine } from '@looseleaf/model';
import { useServices } from '../app/services.js';
import type { DragData } from './BoardView.js';
import { tickLine } from './line-actions.js';
import { showLineMenu } from './line-menu.js';
import type { CurrentBoard } from './live-board.js';
import { openPage } from './open-page.js';

export function InboxLane({ current, lines, dragDisabled }: { current: CurrentBoard; lines: InboxLine[]; dragDisabled: boolean }) {
  if (lines.length === 0) return null;
  // The dock keeps the lane at the board's left edge while the statuses scroll under it.
  return (
    <div className="inbox-dock">
      <section className="inbox-lane" aria-label="Inbox" data-testid="inbox">
        <header className="inbox-header">
          <MailInboxRegular className="inbox-icon" aria-hidden="true" />
          <h2 className="status-name">Inbox</h2>
          <span className="status-count" aria-label={`${lines.length} lines`}>
            {lines.length}
          </span>
        </header>
        <ol className="inbox-list">
          {lines.map((line) => (
            <InboxItem key={line.id} current={current} line={line} dragDisabled={dragDisabled} />
          ))}
        </ol>
      </section>
    </div>
  );
}

function InboxItem({ current, line, dragDisabled }: { current: CurrentBoard; line: InboxLine; dragDisabled: boolean }) {
  const services = useServices();
  const ref = { notebookId: current.notebookId, pageId: line.pageId, lineId: line.id };
  const drag = useDraggable({ id: `line:${line.id}`, data: { type: 'line', lineId: line.id, pageId: line.pageId } satisfies DragData, disabled: dragDisabled });
  // Presses and keys on the controls inside the line stay theirs, so using one never starts a drag.
  const fromControl = (event: { target: EventTarget; currentTarget: EventTarget }) =>
    event.target !== event.currentTarget && !!(event.target as HTMLElement).closest?.('button, input, label');
  const listeners = Object.fromEntries(
    Object.entries(drag.listeners ?? {}).map(([name, handler]) => [name, (event: React.SyntheticEvent) => fromControl(event) || handler(event)]),
  );
  return (
    <li
      ref={drag.setNodeRef}
      className={`inbox-line ${drag.isDragging ? 'is-placeholder' : ''}`}
      data-line-id={line.id}
      {...drag.attributes}
      {...listeners}
      role={undefined}
      aria-roledescription={dragDisabled ? undefined : 'draggable line'}
      aria-label={line.text || 'Empty line'}
      onContextMenu={(event) => {
        event.preventDefault();
        showLineMenu(services, current.board, ref, event.clientX, event.clientY);
      }}
    >
      <label className="inbox-tick-hit">
        <input type="checkbox" className="inbox-tick" checked={false} aria-label={`Tick ${line.text || 'the line'}`} onChange={() => void tickLine(services, ref, true)} />
      </label>
      <span className="inbox-body">
        <span className="inbox-text">{line.text || <span className="muted">Empty line</span>}</span>
        <button type="button" className="inbox-source" onClick={() => openPage(services, line.pageId)} title={`Open ${line.pageTitle || 'Untitled page'}`}>
          <DocumentRegular aria-hidden="true" />
          <span>{line.pageTitle || 'Untitled page'}</span>
        </button>
      </span>
      <button
        type="button"
        className="icon-button inbox-menu-button"
        aria-label="Line actions"
        title="Line actions"
        aria-haspopup="menu"
        onClick={(event) => {
          const r = event.currentTarget.getBoundingClientRect();
          showLineMenu(services, current.board, ref, r.left, r.bottom + 4);
        }}
      >
        <MoreHorizontalRegular />
      </button>
    </li>
  );
}

/** A line as it follows the pointer while dragged. */
export function InboxLineOverlay({ line }: { line: InboxLine }) {
  return (
    <div className="inbox-line is-overlay">
      <span className="inbox-tick-hit">
        <input type="checkbox" className="inbox-tick" checked={false} readOnly tabIndex={-1} aria-hidden="true" />
      </span>
      <span className="inbox-body">
        <span className="inbox-text">{line.text}</span>
      </span>
    </div>
  );
}
