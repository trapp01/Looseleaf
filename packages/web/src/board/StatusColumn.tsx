/**
 * One status as a column: a header (drag handle, name to rename in place,
 * card count, kind marker, menu), "Add a card" under it, and its cards
 * scrolling inside, with a marker where a dragged Inbox line would land. The
 * column is only as tall as its content.
 */
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { AddRegular, ArchiveRegular, ArrowLeftRegular, ArrowRightRegular, CheckmarkRegular, MoreHorizontalRegular, OpenRegular, RenameRegular } from '@fluentui/react-icons';
import { archiveStatus, cardLabels, moveStatus, restoreStatus, updateStatus, type Card, type Status, type StatusKind } from '@looseleaf/model';
import { useServices } from '../app/services.js';
import { useStore } from '../app/store.js';
import { patchUi } from '../app/ui-state.js';
import { showMenu, type MenuItem } from '../nav/context-menu.js';
import type { DragData } from './BoardView.js';
import { boardHover } from './board-shortcuts.js';
import { archiveWithUndo } from './card-actions.js';
import { CardComposer } from './CardComposer.js';
import { CardFront } from './CardFront.js';
import { KindMarker, KIND_NAMES } from './KindMarker.js';
import type { CurrentBoard } from './live-board.js';
import { openPage, openPageId } from './open-page.js';

export function StatusColumn({
  current,
  status,
  index,
  cards,
  totalCards,
  filtering,
  draggingCardId,
  lineDropIndex,
}: {
  current: CurrentBoard;
  status: Status;
  index: number;
  /** The cards showing, in order (during a drag, where the drag puts them). */
  cards: Card[];
  /** Every card in the status, filtered out or not. */
  totalCards: number;
  filtering: boolean;
  draggingCardId: string | null;
  /** Where a dragged Inbox line would become a card in this status, or null. */
  lineDropIndex: number | null;
}) {
  const { ui, toasts, selection } = useServices();
  const { doc, board, notebookId, flashing } = current;
  const state = useStore(ui);
  const openId = openPageId(state.view, state.boardPage, useStore(selection).pageId);
  const composerOpen = state.composer === status.id;
  const sortable = useSortable({ id: `status:${status.id}`, data: { type: 'status', statusId: status.id } satisfies DragData });
  const body = useDroppable({ id: `column:${status.id}`, data: { type: 'column', statusId: status.id } satisfies DragData });
  const [renaming, setRenaming] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  // A press that ends a header drag must not also open the rename field.
  const lastDragEnd = useRef(0);
  const wasDragging = useRef(false);
  useEffect(() => {
    if (wasDragging.current && !sortable.isDragging) lastDragEnd.current = Date.now();
    wasDragging.current = sortable.isDragging;
  }, [sortable.isDragging]);

  const archive = () => {
    archiveStatus(doc, status.id);
    toasts.show(`Archived ${status.name}${totalCards > 0 ? ` and its ${totalCards === 1 ? 'card' : `${totalCards} cards`}` : ''}`, () =>
      restoreStatus(doc, status.id),
    );
  };
  const kindItem = (kind: StatusKind): MenuItem => ({
    label: `Kind: ${KIND_NAMES[kind]}`,
    icon: status.kind === kind ? <CheckmarkRegular /> : undefined,
    onSelect: () => updateStatus(doc, status.id, { kind }),
  });
  const openMenu = () => {
    const r = menuButton.current!.getBoundingClientRect();
    showMenu(r.left, r.bottom + 4, [
      { label: 'Rename', icon: <RenameRegular />, onSelect: () => setRenaming(true) },
      'separator',
      kindItem('todo'),
      kindItem('doing'),
      kindItem('done'),
      'separator',
      { label: 'Move left', icon: <ArrowLeftRegular />, disabled: index === 0, onSelect: () => moveStatus(doc, status.id, index - 1) },
      { label: 'Move right', icon: <ArrowRightRegular />, disabled: index === board.statuses.length - 1, onSelect: () => moveStatus(doc, status.id, index + 1) },
      'separator',
      { label: 'Archive status', icon: <ArchiveRegular />, onSelect: archive },
    ]);
  };

  const count = filtering ? `${cards.length} of ${totalCards}` : String(totalCards);
  return (
    <section
      ref={sortable.setNodeRef}
      className={`status-column kind-${status.kind} ${sortable.isDragging ? 'is-dragging' : ''} ${lineDropIndex !== null ? 'is-line-target' : ''}`}
      style={{ transform: CSS.Translate.toString(sortable.transform), transition: sortable.transition }}
      aria-label={`${status.name}, ${KIND_NAMES[status.kind]}`}
      data-status-id={status.id}
      onPointerEnter={() => boardHover.set({ ...boardHover.get(), statusId: status.id })}
      onPointerLeave={() => boardHover.get().statusId === status.id && boardHover.set({ statusId: null, cardId: null })}
    >
      <header className="status-header" {...sortable.attributes} {...sortable.listeners} aria-roledescription="draggable status" aria-label={`Move status ${status.name}`}>
        <KindMarker kind={status.kind} />
        {renaming ? (
          <RenameStatus status={status} onSave={(name) => updateStatus(doc, status.id, { name })} onDone={() => setRenaming(false)} />
        ) : (
          <h2 className="status-name">
            <button
              type="button"
              className="status-name-button"
              onClick={() => Date.now() - lastDragEnd.current > 300 && setRenaming(true)}
              onKeyDown={(e) => e.stopPropagation()}
              title="Rename"
            >
              {status.name}
            </button>
          </h2>
        )}
        <span className="status-count" aria-label={`${count} cards`}>
          {count}
        </span>
        <button
          ref={menuButton}
          type="button"
          className="icon-button status-menu-button"
          aria-label={`${status.name} actions`}
          title={`${status.name} actions`}
          aria-haspopup="menu"
          onClick={openMenu}
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <MoreHorizontalRegular />
        </button>
      </header>
      {composerOpen ? (
        <CardComposer
          notebookId={notebookId}
          statusId={status.id}
          onAdded={() => body.node.current?.scrollTo({ top: 0 })}
          onClose={() => patchUi(ui, { composer: null })}
        />
      ) : (
        <button type="button" className="add-card-button" onClick={() => patchUi(ui, { composer: status.id })}>
          <AddRegular aria-hidden="true" />
          Add a card
        </button>
      )}
      <div ref={body.setNodeRef} className="status-cards">
        <SortableContext items={cards.map((card) => `card:${card.id}`)} strategy={verticalListSortingStrategy}>
          <ol className="card-list">
            {cards.flatMap((card, at) => [
              at === lineDropIndex && <li key="line-drop" className="line-drop-marker" aria-hidden="true" />,
              <SortableCard
                key={card.id}
                current={current}
                card={card}
                status={status}
                disabled={filtering}
                flashing={flashing.has(card.id)}
                placeholder={card.id === draggingCardId}
                open={card.id === openId}
                labels={cardLabels(board, card)}
                boardKey={board.meta.key}
              />,
            ])}
            {lineDropIndex !== null && lineDropIndex >= cards.length && <li className="line-drop-marker" aria-hidden="true" />}
          </ol>
        </SortableContext>
      </div>
    </section>
  );
}

/** A card in its status: draggable, and with Open and Archive on right-click (or a long press where the browser makes one a context menu). */
function SortableCard({
  current,
  card,
  status,
  disabled,
  flashing,
  placeholder,
  open,
  labels,
  boardKey,
}: {
  current: CurrentBoard;
  card: Card;
  status: Status;
  disabled: boolean;
  flashing: boolean;
  placeholder: boolean;
  open: boolean;
  labels: ReturnType<typeof cardLabels>;
  boardKey: string;
}) {
  const services = useServices();
  const sortable = useSortable({ id: `card:${card.id}`, data: { type: 'card', cardId: card.id } satisfies DragData, disabled });
  return (
    <li
      ref={sortable.setNodeRef}
      className={`card-slot ${placeholder ? 'is-placeholder' : ''}`}
      style={{ transform: CSS.Translate.toString(sortable.transform), transition: sortable.transition }}
      onPointerEnter={() => boardHover.set({ statusId: status.id, cardId: card.id })}
      onPointerLeave={() => boardHover.set({ ...boardHover.get(), cardId: null })}
      onContextMenu={(event) => {
        event.preventDefault();
        showMenu(event.clientX, event.clientY, [
          { label: 'Open', icon: <OpenRegular />, onSelect: () => openPage(services, card.id) },
          { label: 'Archive', icon: <ArchiveRegular />, onSelect: () => archiveWithUndo(services, current, card) },
        ]);
      }}
    >
      <CardFront
        card={card}
        labels={labels}
        boardKey={boardKey}
        kind={status.kind}
        flashing={flashing}
        open={open}
        dragHandle={{ ...sortable.attributes, ...sortable.listeners, role: undefined, 'aria-roledescription': disabled ? undefined : 'draggable card' }}
      />
    </li>
  );
}

function RenameStatus({ status, onSave, onDone }: { status: Status; onSave: (name: string) => void; onDone: () => void }) {
  const [name, setName] = useState(status.name);
  const save = () => {
    if (name.trim() !== '' && name.trim() !== status.name) onSave(name);
    onDone();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    event.stopPropagation();
    if (event.key === 'Enter') save();
    if (event.key === 'Escape') {
      event.preventDefault();
      onDone();
    }
  };
  return (
    <input
      className="status-rename"
      aria-label="Status name"
      value={name}
      onChange={(e) => setName(e.target.value)}
      onBlur={save}
      onKeyDown={onKeyDown}
      onPointerDown={(e) => e.stopPropagation()}
      autoFocus
      onFocus={(e) => e.target.select()}
      maxLength={60}
    />
  );
}
