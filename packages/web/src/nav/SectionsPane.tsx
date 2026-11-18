/**
 * The sections pane: the notebook switcher on top, the "Board" row when the
 * notebook has a board, the notebook's section groups (with disclosure) and
 * coloured section tabs, and "Add section" pinned at the bottom. Rows rename
 * in place, open a context menu on right-click or long-press, and take drops
 * of sections, groups and pages.
 */
import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import {
  AddRegular,
  ArrowDownloadRegular,
  BoardRegular,
  ArrowMoveRegular,
  ChevronDownRegular,
  ChevronRightRegular,
  DeleteRegular,
  FolderRegular,
  FolderAddRegular,
  RenameRegular,
} from '@fluentui/react-icons';
import type * as Y from 'yjs';
import {
  COLORS,
  colorHex,
  createSection,
  deleteNode,
  moveNode,
  renameNode,
  setSectionColor,
  type GroupEntry,
  type SectionEntry,
  type TreeChild,
} from '@looseleaf/model';
import { readLocal, writeLocal } from '../app/local-settings.js';
import { nextName, useServices } from '../app/services.js';
import { allSections } from '../app/selection.js';
import { useStore } from '../app/store.js';
import { patchUi } from '../app/ui-state.js';
import { useCurrentBoard } from '../board/live-board.js';
import { useRowMenu, type MenuEntry } from './context-menu.js';
import { DRAG_TYPE, dropPosition, indexAmong, type DragPayload, type DropPosition } from './drop.js';
import { NotebookSwitcher } from './NotebookSwitcher.js';
import { useNotebookTree } from './notebook-docs.js';
import { RenameInput } from './RenameInput.js';
import { currentDrag, setCurrentDrag } from './drag-state.js';

type Row =
  | { kind: 'group'; entry: GroupEntry; depth: number; parent: string | null; expanded: boolean }
  | { kind: 'section'; entry: SectionEntry; depth: number; parent: string | null };

const EXPANDED_KEY = 'expandedGroups';

export function SectionsPane({ onOpenSection, onOpenBoard }: { onOpenSection?: () => void; onOpenBoard?: () => void }) {
  const { selection, notebooks, ui, commands } = useServices();
  const sel = useStore(selection);
  const view = useStore(ui).view;
  const board = useCurrentBoard();
  const hasBoard = board !== null && board.notebookId === sel.notebookId;
  const doc = useStore(notebooks.docs).get(sel.notebookId ?? '') ?? null;
  const tree = useNotebookTree(doc);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(readLocal<string[]>(EXPANDED_KEY, [])));
  const [drop, setDrop] = useState<{ id: string | null; position: DropPosition } | null>(null);

  const toggle = (id: string, open?: boolean) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (open ?? !next.has(id)) next.add(id);
      else next.delete(id);
      writeLocal(EXPANDED_KEY, [...next]);
      return next;
    });

  // Open the groups around the selected section so it is visible.
  useEffect(() => {
    const path = groupPath(tree.children, sel.sectionId ?? '');
    if (path && path.some((g) => !expanded.has(g))) path.forEach((g) => toggle(g, true));
  }, [tree, sel.sectionId]);

  const rows = useMemo(() => flatten(tree.children, expanded), [tree, expanded]);

  const onDrop = (event: DragEvent, row: Row | null, position: DropPosition) => {
    event.preventDefault();
    setDrop(null);
    const payload = currentDrag();
    setCurrentDrag(null);
    if (!doc || !payload || payload.notebookId !== sel.notebookId) return;
    try {
      if (payload.kind === 'page') {
        if (row?.kind === 'section') moveNode(doc, payload.id, { parent: row.entry.id });
        return;
      }
      if (!row) return moveNode(doc, payload.id, { parent: null });
      if (position === 'into' && row.kind === 'group') {
        moveNode(doc, payload.id, { parent: row.entry.id });
        toggle(row.entry.id, true);
        return;
      }
      const siblings = childrenOf(tree.children, row.parent).map((c) => c.id);
      const index = indexAmong(siblings, new Set([payload.id]), row.entry.id, position === 'before' ? 'before' : 'after');
      if (index !== null) moveNode(doc, payload.id, { parent: row.parent, index });
    } catch (error) {
      console.warn('That move is not possible', error);
    }
  };

  const dragOverRow = (event: DragEvent, row: Row) => {
    const payload = currentDrag();
    if (!payload || payload.id === row.entry.id) return;
    if (payload.kind === 'page' && row.kind !== 'section') return;
    event.preventDefault();
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const position: DropPosition =
      payload.kind === 'page' ? 'into' : dropPosition(event.clientY - rect.top, rect.height, row.kind === 'group');
    setDrop({ id: row.entry.id, position });
  };

  return (
    <div className="pane sections-pane">
      <NotebookSwitcher />
      <div
        className="pane-list"
        role="tree"
        aria-label="Sections"
        onDragOver={(e) => {
          if (currentDrag() && currentDrag()!.kind !== 'page' && e.target === e.currentTarget) {
            e.preventDefault();
            setDrop({ id: null, position: 'after' });
          }
        }}
        onDragLeave={(e) => e.target === e.currentTarget && setDrop(null)}
        onDrop={(e) => e.target === e.currentTarget && onDrop(e, null, 'after')}
      >
        {hasBoard && (
          <BoardRow
            selected={view === 'board'}
            onSelect={() => {
              patchUi(ui, { view: 'board' });
              onOpenBoard?.();
            }}
          />
        )}
        {rows.map((row) => (
          <SectionRow
            key={row.entry.id}
            row={row}
            doc={doc}
            selected={view !== 'board' && row.kind === 'section' && row.entry.id === sel.sectionId}
            dropHint={drop?.id === row.entry.id ? drop.position : null}
            onSelect={() => {
              if (row.kind === 'group') return toggle(row.entry.id);
              selection.selectSection(row.entry.id);
              patchUi(ui, { view: 'page' });
              onOpenSection?.();
            }}
            onDragOver={(e) => dragOverRow(e, row)}
            onDragLeave={() => setDrop(null)}
            onDrop={(e) => onDrop(e, row, drop?.position ?? 'after')}
          />
        ))}
        {drop?.id === null && <div className="drop-line-end" />}
      </div>
      <button className="pane-add" onClick={() => commands.run('new-section')}>
        <AddRegular /> Add section
      </button>
    </div>
  );
}

/** The notebook's board, as a row above its sections. */
function BoardRow({ selected, onSelect }: { selected: boolean; onSelect: () => void }) {
  return (
    <div
      className={`row board-row ${selected ? 'is-selected' : ''}`}
      role="treeitem"
      aria-selected={selected}
      tabIndex={0}
      style={{ paddingLeft: 12 }}
      onClick={onSelect}
      onKeyDown={(e) => e.key === 'Enter' && onSelect()}
    >
      <BoardRegular className="row-icon board-row-icon" />
      <span className="row-label">Board</span>
    </div>
  );
}

function SectionRow({
  row,
  doc,
  selected,
  dropHint,
  onSelect,
  onDragOver,
  onDragLeave,
  onDrop,
}: {
  row: Row;
  doc: Y.Doc | null;
  selected: boolean;
  dropHint: DropPosition | null;
  onSelect: () => void;
  onDragOver: (e: DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (e: DragEvent) => void;
}) {
  const { ui, selection, commands } = useServices();
  const renaming = useStore(ui).renaming === row.entry.id;
  const notebookId = selection.get().notebookId!;
  const entries = (): MenuEntry[] => {
    if (!doc) return [];
    const id = row.entry.id;
    const common: MenuEntry[] = [
      { label: 'Rename', icon: <RenameRegular />, onSelect: () => patchUi(ui, { renaming: id }) },
    ];
    if (row.kind === 'section') {
      return [
        ...common,
        {
          label: 'Section colour',
          swatches: COLORS.map((c) => ({ name: c.name, hex: c.hex, selected: c.name === row.entry.color, onSelect: () => setSectionColor(doc, id, c.name) })),
        },
        'separator',
        { label: 'New section', icon: <AddRegular />, onSelect: () => commands.run('new-section') },
        { label: 'New section group', icon: <FolderAddRegular />, onSelect: () => commands.run('new-section-group') },
        { label: 'Move to…', icon: <ArrowMoveRegular />, onSelect: () => patchUi(ui, { dialog: { kind: 'move', notebookId, nodeId: id } }) },
        {
          label: 'Export section…',
          icon: <ArrowDownloadRegular />,
          onSelect: () => patchUi(ui, { dialog: { kind: 'export', scope: 'section', notebookId, sectionId: id } }),
        },
        'separator',
        { label: 'Delete section', icon: <DeleteRegular />, danger: true, onSelect: () => deleteNode(doc, id) },
      ];
    }
    return [
      ...common,
      {
        label: 'New section in group',
        icon: <AddRegular />,
        onSelect: () => {
          const name = nextName('New Section', allSections([row.entry]).map((s) => s.name));
          const sectionId = createSection(doc, { name, parent: id });
          selection.selectSection(sectionId);
          patchUi(ui, { renaming: sectionId });
        },
      },
      { label: 'Move to…', icon: <ArrowMoveRegular />, onSelect: () => patchUi(ui, { dialog: { kind: 'move', notebookId, nodeId: id } }) },
      'separator',
      { label: 'Delete section group', icon: <DeleteRegular />, danger: true, onSelect: () => deleteNode(doc, id) },
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
      className={`row ${selected ? 'is-selected' : ''} ${dropHint ? `drop-${dropHint}` : ''}`}
      role="treeitem"
      aria-selected={selected}
      aria-expanded={row.kind === 'group' ? row.expanded : undefined}
      tabIndex={0}
      style={{ paddingLeft: 12 + row.depth * 16 }}
      draggable={!renaming}
      onDragStart={(e) => {
        const payload: DragPayload = { notebookId, id: row.entry.id, kind: row.kind };
        setCurrentDrag(payload);
        e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(payload));
        e.dataTransfer.effectAllowed = 'move';
      }}
      onDragEnd={() => setCurrentDrag(null)}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onClick={() => !menu.consumedLongPress() && !renaming && onSelect()}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !renaming) onSelect();
        if (e.key === 'F2') patchUi(ui, { renaming: row.entry.id });
      }}
      {...menu.handlers}
    >
      {row.kind === 'group' ? (
        <>
          <span className="disclosure">{row.expanded ? <ChevronDownRegular /> : <ChevronRightRegular />}</span>
          <FolderRegular className="row-icon" />
        </>
      ) : (
        <span className="section-tab" style={{ background: colorHex(row.entry.color) }} />
      )}
      {renaming && doc ? (
        <RenameInput
          value={row.entry.name}
          onDone={(name) => {
            if (name) renameNode(doc, row.entry.id, name);
            patchUi(ui, { renaming: null });
          }}
        />
      ) : (
        <span className="row-label">{row.entry.name || (row.kind === 'group' ? 'Untitled section group' : 'Untitled section')}</span>
      )}
    </div>
  );
}

function flatten(children: TreeChild[], expanded: Set<string>, depth = 0, parent: string | null = null): Row[] {
  return children.flatMap((c): Row[] => {
    if (c.kind === 'section') return [{ kind: 'section', entry: c, depth, parent }];
    const open = expanded.has(c.id);
    return [{ kind: 'group', entry: c, depth, parent, expanded: open }, ...(open ? flatten(c.children, expanded, depth + 1, c.id) : [])];
  });
}

function childrenOf(children: TreeChild[], parent: string | null): TreeChild[] {
  if (parent === null) return children;
  for (const c of children) {
    if (c.kind !== 'group') continue;
    if (c.id === parent) return c.children;
    const found = childrenOf(c.children, parent);
    if (found.length > 0) return found;
  }
  return [];
}

/** The ids of the groups that hold a section, outermost first; null when it is not inside one. */
function groupPath(children: TreeChild[], sectionId: string, path: string[] = []): string[] | null {
  for (const c of children) {
    if (c.kind === 'section' && c.id === sectionId) return path;
    if (c.kind === 'group') {
      const found = groupPath(c.children, sectionId, [...path, c.id]);
      if (found) return found;
    }
  }
  return null;
}
