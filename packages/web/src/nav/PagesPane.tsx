/**
 * The pages pane: the selected section's pages with subpage indent, a sort
 * control (manual order, title, date created, date modified), "Add page"
 * pinned at the bottom, drag to reorder in manual order, and a context menu
 * per row (make subpage, promote, move, put on board, export, delete). A
 * page that is a card shows its status after its title.
 */
import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import {
  AddRegular,
  ArrowDownloadRegular,
  ArrowLeftRegular,
  ArrowMoveRegular,
  ArrowSortRegular,
  BoardRegular,
  CheckmarkRegular,
  DeleteRegular,
  TextIndentDecreaseRegular,
  TextIndentIncreaseRegular,
} from '@fluentui/react-icons';
import { deleteNode, findStatus, moveNode, putOnBoard, setPageLevel, shownStatusId, type PageEntry, type PageLevel } from '@looseleaf/model';
import { Popover } from '../app/controls.js';
import { readLocal, writeLocal } from '../app/local-settings.js';
import { useServices } from '../app/services.js';
import { allSections } from '../app/selection.js';
import { useStore } from '../app/store.js';
import { patchUi } from '../app/ui-state.js';
import { liveCard, useCurrentBoard, type CurrentBoard } from '../board/live-board.js';
import { useRowMenu, type MenuEntry } from './context-menu.js';
import { DRAG_TYPE, indexAmong, pageBlock, dropPosition, type DragPayload } from './drop.js';
import { currentDrag, setCurrentDrag } from './drag-state.js';
import { useNotebookTree } from './notebook-docs.js';

export type PageSort = 'manual' | 'title' | 'created' | 'modified';

const SORT_LABELS: Record<PageSort, string> = {
  manual: 'Manual order',
  title: 'Title',
  created: 'Date created',
  modified: 'Date modified',
};
const SORT_KEY = 'pageSort';

/** Pages in the chosen order; anything but manual order is flat. */
export function sortPages(pages: PageEntry[], sort: PageSort): PageEntry[] {
  if (sort === 'manual') return pages;
  const sorted = [...pages];
  if (sort === 'title') sorted.sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: 'base' }));
  if (sort === 'created') sorted.sort((a, b) => b.createdAt - a.createdAt);
  if (sort === 'modified') sorted.sort((a, b) => b.modifiedAt - a.modifiedAt);
  return sorted;
}

export function PagesPane({ onBack, onOpenPage }: { onBack?: () => void; onOpenPage?: () => void }) {
  const { selection, notebooks, commands, ui } = useServices();
  const sel = useStore(selection);
  const doc = useStore(notebooks.docs).get(sel.notebookId ?? '') ?? null;
  const tree = useNotebookTree(doc);
  const section = allSections(tree.children).find((s) => s.id === sel.sectionId) ?? null;
  const [sort, setSort] = useState<PageSort>(() => readLocal<PageSort>(SORT_KEY, 'manual'));
  const [sortOpen, setSortOpen] = useState(false);
  const sortButton = useRef<HTMLButtonElement>(null);
  const [drop, setDrop] = useState<{ id: string; position: 'before' | 'after' } | null>(null);
  const pages = useMemo(() => sortPages(section?.pages ?? [], sort), [section, sort]);
  const current = useCurrentBoard();
  const board = current && current.notebookId === sel.notebookId ? current : null;

  const onDrop = (event: DragEvent, target: PageEntry) => {
    event.preventDefault();
    const position = drop?.position ?? 'after';
    setDrop(null);
    const payload = currentDrag();
    setCurrentDrag(null);
    if (!doc || !section || payload?.kind !== 'page' || payload.notebookId !== sel.notebookId) return;
    const all = section.pages;
    const moving = all.some((p) => p.id === payload.id) ? pageBlock(all, payload.id) : new Set([payload.id]);
    const index = indexAmong(all.map((p) => p.id), moving, target.id, position);
    if (index !== null) moveNode(doc, payload.id, { parent: section.id, index });
  };

  return (
    <div className="pane pages-pane">
      <div className="pane-header pages-header">
        {onBack && (
          <button className="icon-button back-button" aria-label="Back to sections" onClick={onBack}>
            <ArrowLeftRegular />
          </button>
        )}
        <span className="pages-section-name" title={section?.name}>
          {section?.name ?? ''}
        </span>
        <button
          ref={sortButton}
          className="icon-button"
          aria-label={`Sort pages: ${SORT_LABELS[sort]}`}
          title={`Sort: ${SORT_LABELS[sort]}`}
          onClick={() => setSortOpen((o) => !o)}
        >
          <ArrowSortRegular />
        </button>
        {sortOpen && (
          <Popover anchor={sortButton.current} onClose={() => setSortOpen(false)} align="end" className="menu-popover">
            <div role="menu" className="menu-list">
              <div className="menu-heading">Sort by</div>
              {(Object.keys(SORT_LABELS) as PageSort[]).map((s) => (
                <button
                  key={s}
                  role="menuitemradio"
                  aria-checked={s === sort}
                  className="menu-item"
                  onClick={() => {
                    setSort(s);
                    writeLocal(SORT_KEY, s);
                    setSortOpen(false);
                  }}
                >
                  <span className="menu-label">{SORT_LABELS[s]}</span>
                  {s === sort && <CheckmarkRegular className="menu-check" />}
                </button>
              ))}
            </div>
          </Popover>
        )}
      </div>
      <div className="pane-list" role="list" aria-label="Pages">
        {section && pages.length === 0 && <p className="pane-empty">No pages yet.</p>}
        {pages.map((page, i) => (
          <PageRow
            key={page.id}
            page={page}
            board={board}
            previousLevel={sort === 'manual' ? (pages[i - 1]?.level ?? -1) : -1}
            indent={sort === 'manual'}
            selected={page.id === sel.pageId}
            draggable={sort === 'manual'}
            dropHint={drop?.id === page.id ? drop.position : null}
            onOpen={() => {
              selection.selectPage(page.id);
              patchUi(ui, { view: 'page', phonePane: 'page' });
              onOpenPage?.();
            }}
            onDragOver={(e) => {
              if (currentDrag()?.kind !== 'page' || sort !== 'manual') return;
              e.preventDefault();
              const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
              setDrop({ id: page.id, position: dropPosition(e.clientY - rect.top, rect.height, false) as 'before' | 'after' });
            }}
            onDragLeave={() => setDrop(null)}
            onDrop={(e) => onDrop(e, page)}
          />
        ))}
      </div>
      {section && (
        <button className="pane-add" onClick={() => commands.run('new-page')}>
          <AddRegular /> Add page
        </button>
      )}
    </div>
  );
}

/** The status a page's card shows under, or null when the page is not a card on the board. */
function cardStatus(board: CurrentBoard | null, pageId: string): string | null {
  const card = board ? liveCard(board.board, pageId) : null;
  if (!board || !card) return null;
  const statusId = shownStatusId(board.board, card);
  return statusId ? (findStatus(board.board, statusId)?.name ?? null) : null;
}

function PageRow({
  page,
  board,
  previousLevel,
  indent,
  selected,
  draggable,
  dropHint,
  onOpen,
  onDragOver,
  onDragLeave,
  onDrop,
}: {
  page: PageEntry;
  board: CurrentBoard | null;
  previousLevel: number;
  indent: boolean;
  selected: boolean;
  draggable: boolean;
  dropHint: 'before' | 'after' | null;
  onOpen: () => void;
  onDragOver: (e: DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (e: DragEvent) => void;
}) {
  const { selection, notebooks, ui, commands, actor } = useServices();
  const notebookId = selection.get().notebookId!;
  const status = cardStatus(board, page.id);
  const isCard = board !== null && liveCard(board.board, page.id) !== null;
  const entries = (): MenuEntry[] => {
    const doc = notebooks.get(notebookId);
    if (!doc) return [];
    const setLevel = (level: number) => setPageLevel(doc, page.id, Math.max(0, Math.min(2, level)) as PageLevel);
    return [
      { label: 'New page', icon: <AddRegular />, onSelect: () => commands.run('new-page') },
      'separator',
      { label: 'Make subpage', icon: <TextIndentIncreaseRegular />, disabled: page.level >= 2 || page.level > previousLevel, onSelect: () => setLevel(page.level + 1) },
      { label: 'Promote subpage', icon: <TextIndentDecreaseRegular />, disabled: page.level === 0, onSelect: () => setLevel(page.level - 1) },
      { label: 'Move to…', icon: <ArrowMoveRegular />, onSelect: () => patchUi(ui, { dialog: { kind: 'move', notebookId, nodeId: page.id } }) },
      ...(board && !isCard
        ? [{ label: 'Put on board', icon: <BoardRegular />, onSelect: () => void putOnBoard(board.doc, page.id, { by: actor.get() }) }]
        : []),
      {
        label: 'Export page…',
        icon: <ArrowDownloadRegular />,
        onSelect: () => patchUi(ui, { dialog: { kind: 'export', scope: 'page', notebookId, pageId: page.id } }),
      },
      'separator',
      { label: 'Delete page', icon: <DeleteRegular />, danger: true, onSelect: () => deleteNode(doc, page.id) },
    ];
  };
  const menu = useRowMenu(entries);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [selected]);
  return (
    <div
      ref={ref}
      role="listitem"
      tabIndex={0}
      className={`row page-row ${selected ? 'is-selected' : ''} ${dropHint ? `drop-${dropHint}` : ''}`}
      aria-current={selected ? 'page' : undefined}
      style={{ paddingLeft: 16 + (indent ? page.level * 16 : 0) }}
      draggable={draggable}
      onDragStart={(e) => {
        const payload: DragPayload = { notebookId, id: page.id, kind: 'page' };
        setCurrentDrag(payload);
        e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(payload));
        e.dataTransfer.effectAllowed = 'move';
      }}
      onDragEnd={() => setCurrentDrag(null)}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onClick={() => !menu.consumedLongPress() && onOpen()}
      onKeyDown={(e) => e.key === 'Enter' && onOpen()}
      {...menu.handlers}
    >
      <span className={`row-label ${page.title ? '' : 'is-untitled'}`}>{page.title || 'Untitled page'}</span>
      {status !== null && <span className="row-status">{status}</span>}
    </div>
  );
}
