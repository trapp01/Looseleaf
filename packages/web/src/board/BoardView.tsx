/**
 * The Inbox lane, then the board's statuses side by side, scrolling sideways,
 * and the "Add a status" tile after the last. Cards drag within and between
 * statuses, statuses drag by their header, and Inbox lines drag into a
 * status to become cards at the drop, by pointer, touch (press and hold) or
 * keyboard (Space to lift, arrows to move, Space to drop). Nothing drops into
 * the Inbox. Dragging is off while the filter hides cards, since a place
 * among hidden cards is ambiguous.
 */
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  closestCenter,
  closestCorners,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  pointerWithin,
  TouchSensor,
  useSensor,
  useSensors,
  type CollisionDetection,
  type Active,
  type DragEndEvent,
  type DragMoveEvent,
  type DragOverEvent,
  type Over,
  type DragStartEvent,
} from '@dnd-kit/core';
import { horizontalListSortingStrategy, SortableContext, sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { cardLabels, cardsInStatus, moveCard, moveStatus, type Card, type InboxLine } from '@looseleaf/model';
import { useServices } from '../app/services.js';
import { AddStatus } from './AddStatus.js';
import { CardFront } from './CardFront.js';
import { columnOf, dragOver, dropPlace, lineDropPlace, samePlace, type Columns, type DragOver } from './drag-model.js';
import { useCardFilter } from './filter.js';
import { InboxLane, InboxLineOverlay } from './InboxLane.js';
import { makeCard, useInbox } from './line-actions.js';
import type { CurrentBoard } from './live-board.js';
import { useEdgeScroll } from './edge-scroll.js';
import { StatusColumn } from './StatusColumn.js';

export type DragData =
  | { type: 'card'; cardId: string }
  | { type: 'column'; statusId: string }
  | { type: 'status'; statusId: string }
  | { type: 'line'; lineId: string; pageId: string };

type Place = { statusId: string; index: number };

/** dnd-kit scrolls a status's cards up and down; edge-scroll.ts scrolls the board sideways, past the pinned Inbox. */
const VERTICAL_AUTO_SCROLL = { threshold: { x: 0, y: 0.2 } };

type Drag =
  | { kind: 'card'; cardId: string; start: Columns; columns: Columns }
  | { kind: 'status'; statusId: string }
  | { kind: 'line'; line: InboxLine; place: Place | null };

const dataOf = (item: { data: { current?: unknown } } | null | undefined): DragData | undefined => item?.data.current as DragData | undefined;

/**
 * Statuses collide with statuses only. Cards prefer the card under the
 * pointer, then a status's empty space, then the nearest card. Lines take
 * only what is under the pointer, so a line let go over the Inbox or off the
 * statuses stays a line; from the keyboard they take the nearest card or status.
 */
const collision: CollisionDetection = (args) => {
  const type = dataOf(args.active)?.type;
  if (type === 'status') {
    return closestCenter({ ...args, droppableContainers: args.droppableContainers.filter((c) => dataOf(c)?.type === 'status') });
  }
  if (type === 'line') {
    const targets = args.droppableContainers.filter((c) => ['card', 'column', 'status'].includes(dataOf(c)?.type ?? ''));
    if (args.pointerCoordinates === null) return closestCorners({ ...args, droppableContainers: targets });
    const within = pointerWithin({ ...args, droppableContainers: targets });
    const rank = (id: unknown) => ['card', 'column', 'status'].indexOf(dataOf(targets.find((c) => c.id === id))?.type ?? '');
    return within.sort((a, b) => rank(a.id) - rank(b.id)).slice(0, 1);
  }
  const targets = args.droppableContainers.filter((c) => dataOf(c)?.type === 'card' || dataOf(c)?.type === 'column');
  const within = pointerWithin({ ...args, droppableContainers: targets });
  const card = within.find((hit) => dataOf(targets.find((c) => c.id === hit.id))?.type === 'card');
  if (card) return [card];
  if (within.length > 0) return within;
  return closestCorners({ ...args, droppableContainers: targets });
};

export function BoardView({ current }: { current: CurrentBoard }) {
  const services = useServices();
  const { doc, board } = current;
  const { matches } = useCardFilter(board);
  const filtering = matches !== null;
  const inbox = useInbox(current);
  const shown = useMemo<Columns>(
    () =>
      Object.fromEntries(
        board.statuses.map((status) => [status.id, cardsInStatus(board, status.id).filter((card) => matches === null || matches.has(card.id)).map((card) => card.id)]),
      ),
    [board, matches],
  );
  const cardsById = useMemo(() => new Map(board.cards.map((card) => [card.id, card])), [board]);
  const [drag, setDragState] = useState<Drag | null>(null);
  // The drop reads the drag from here: drag-over updates may not have re-rendered yet when it lands.
  const dragRef = useRef<Drag | null>(null);
  const setDrag = (next: Drag | null | ((current: Drag | null) => Drag | null)) => {
    dragRef.current = typeof next === 'function' ? next(dragRef.current) : next;
    setDragState(dragRef.current);
  };
  const columns = drag?.kind === 'card' ? drag.columns : shown;
  const boardRef = useRef<HTMLDivElement>(null);
  useEdgeScroll(boardRef, drag !== null && drag.kind !== 'status');
  // An empty Inbox is not shown. On a phone the columns snap, so an Inbox appearing would leave the
  // view on the column it was on; a board still at its start moves back to show the Inbox.
  const atStart = useRef(true);
  const showsInbox = inbox.length > 0;
  useLayoutEffect(() => {
    if (showsInbox && atStart.current) boardRef.current?.scrollTo({ left: 0, behavior: 'instant' });
  }, [showsInbox]);

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
      keyboardCodes: { start: ['Space'], cancel: ['Escape'], end: ['Space', 'Enter'] },
    }),
  );

  const onDragStart = ({ active }: DragStartEvent) => {
    const data = dataOf(active);
    if (data?.type === 'card') setDrag({ kind: 'card', cardId: data.cardId, start: shown, columns: shown });
    else if (data?.type === 'status') setDrag({ kind: 'status', statusId: data.statusId });
    else if (data?.type === 'line') {
      const line = inbox.find((candidate) => candidate.id === data.lineId);
      if (line) setDrag({ kind: 'line', line, place: null });
    }
  };

  // A line's place follows the pointer within a card too (above or below it), so it is worked out on every move.
  const onDragMove = ({ active, over }: DragMoveEvent) => {
    if (dragRef.current?.kind !== 'line') return;
    const target = dataOf(over);
    const place = target ? lineDropPlace(shown, lineOver(target, isBelow(active, over))) : null;
    setDrag((current) => (current?.kind === 'line' && !samePlaceOrNone(current.place, place) ? { ...current, place } : current));
  };

  // Crossing into another status moves the card there while dragging; order inside one status is the sortable's job until the drop.
  const onDragOver = ({ active, over }: DragOverEvent) => {
    if (dragRef.current?.kind === 'line') return;
    const target = dataOf(over);
    const below = isBelow(active, over);
    setDrag((current) => {
      if (current?.kind !== 'card' || !target) return current;
      const from = columnOf(current.columns, current.cardId);
      let next = current.columns;
      // Anywhere on another status that is not one of its cards (its header, its "Add a card" row) counts as that status.
      if ((target.type === 'column' || target.type === 'status') && target.statusId !== from) {
        next = dragOver(current.columns, current.cardId, { kind: 'status', statusId: target.statusId });
      } else if (target.type === 'card' && columnOf(current.columns, target.cardId) !== from) {
        next = dragOver(current.columns, current.cardId, { kind: 'card', cardId: target.cardId, below });
      }
      return next === current.columns ? current : { ...current, columns: next };
    });
  };

  // A card lands where the drag shows it, even when the pointer ends outside every status.
  const onDragEnd = ({ over }: DragEndEvent) => {
    const drag = dragRef.current;
    setDrag(null);
    if (!drag) return;
    if (drag.kind === 'line') {
      if (drag.place) void makeCard(services, { notebookId: current.notebookId, pageId: drag.line.pageId, lineId: drag.line.id }, drag.place.statusId, drag.place.index);
      return;
    }
    if (drag.kind === 'status') {
      const target = dataOf(over);
      if (target?.type !== 'status' || target.statusId === drag.statusId) return;
      moveStatus(doc, drag.statusId, board.statuses.findIndex((status) => status.id === target.statusId));
      return;
    }
    let final = drag.columns;
    const target = dataOf(over);
    if (target?.type === 'card' && target.cardId !== drag.cardId) final = dragOver(final, drag.cardId, { kind: 'card', cardId: target.cardId, below: false });
    if (samePlace(drag.start, final, drag.cardId)) return;
    const place = dropPlace(final, drag.cardId);
    if (place) moveCard(doc, drag.cardId, { statusId: place.statusId, place: place.index }, services.actor.get());
  };

  const dragged = drag?.kind === 'card' ? cardsById.get(drag.cardId) : undefined;
  const statusOf = (card: Card) => board.statuses.find((status) => shown[status.id]?.includes(card.id)) ?? null;

  return (
    <div className="board-frame">
      {filtering && <p className="drag-hint">Dragging is off while the filter is on. Clear it to move cards and lines by dragging.</p>}
      <DndContext sensors={sensors} collisionDetection={collision} autoScroll={VERTICAL_AUTO_SCROLL} onDragStart={onDragStart} onDragMove={onDragMove} onDragOver={onDragOver} onDragEnd={onDragEnd} onDragCancel={() => setDrag(null)}>
        <div
          ref={boardRef}
          className="board"
          data-testid="board"
          onScroll={(event) => {
            atStart.current = event.currentTarget.scrollLeft === 0;
            event.currentTarget.classList.toggle('is-scrolled', !atStart.current);
          }}
        >
          <InboxLane current={current} lines={inbox} dragDisabled={filtering} />
          <SortableContext items={board.statuses.map((status) => `status:${status.id}`)} strategy={horizontalListSortingStrategy}>
            {board.statuses.map((status, index) => (
              <StatusColumn
                key={status.id}
                current={current}
                status={status}
                index={index}
                cards={(columns[status.id] ?? []).map((id) => cardsById.get(id)).filter((card): card is Card => card !== undefined)}
                totalCards={cardsInStatus(board, status.id).length}
                filtering={filtering}
                draggingCardId={drag?.kind === 'card' ? drag.cardId : null}
                lineDropIndex={drag?.kind === 'line' && drag.place?.statusId === status.id ? drag.place.index : null}
              />
            ))}
          </SortableContext>
          <AddStatus doc={doc} />
        </div>
        <DragOverlay dropAnimation={null}>
          {dragged ? (
            <CardFront card={dragged} labels={cardLabels(board, dragged)} boardKey={board.meta.key} kind={statusOf(dragged)?.kind ?? null} overlay />
          ) : drag?.kind === 'line' ? (
            <InboxLineOverlay line={drag.line} />
          ) : null}
        </DragOverlay>
      </DndContext>
    </div>
  );
}

/** True when the middle of the dragged item is past the middle of what it is over. */
function isBelow(active: Active, over: Over | null): boolean {
  const moving = active.rect.current.translated;
  return over !== null && moving !== null && moving.top + moving.height / 2 > over.rect.top + over.rect.height / 2;
}

/** What a dragged line is over, in the drag model's terms: a status's header counts as its empty space. */
function lineOver(target: DragData, below: boolean): DragOver {
  if (target.type === 'card') return { kind: 'card', cardId: target.cardId, below };
  return { kind: 'status', statusId: target.type === 'line' ? '' : target.statusId };
}

function samePlaceOrNone(a: Place | null, b: Place | null): boolean {
  return a === b || (a !== null && b !== null && a.statusId === b.statusId && a.index === b.index);
}
