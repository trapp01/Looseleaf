/**
 * Drag and drop of sections, section groups and pages: what is being dragged,
 * where over a row it would land, and the index `moveNode` needs, which
 * counts the siblings left once the moved nodes are taken out.
 */
import type { NodeKind, PageEntry } from '@looseleaf/model';

export const DRAG_TYPE = 'application/x-looseleaf-node';

export interface DragPayload {
  notebookId: string;
  id: string;
  kind: NodeKind;
}

export type DropPosition = 'before' | 'after' | 'into';

/** Top or bottom half of a row; the middle half means "into" where that is allowed. */
export function dropPosition(offsetY: number, height: number, allowInto: boolean): DropPosition {
  const f = offsetY / height;
  if (allowInto && f > 0.25 && f < 0.75) return 'into';
  return f < 0.5 ? 'before' : 'after';
}

/**
 * The index among `siblingIds` (in display order) with every id in `moving`
 * removed, for landing before or after `targetId`. Null when the target is
 * itself being moved, which is no move at all.
 */
export function indexAmong(siblingIds: string[], moving: ReadonlySet<string>, targetId: string, position: 'before' | 'after'): number | null {
  if (moving.has(targetId)) return null;
  const remaining = siblingIds.filter((id) => !moving.has(id));
  const at = remaining.indexOf(targetId);
  if (at === -1) return null;
  return position === 'before' ? at : at + 1;
}

/** A page and the subpages under it, which move together. */
export function pageBlock(pages: PageEntry[], pageId: string): Set<string> {
  const start = pages.findIndex((p) => p.id === pageId);
  const block = new Set<string>();
  if (start === -1) return block;
  block.add(pageId);
  for (let i = start + 1; i < pages.length && pages[i]!.level > pages[start]!.level; i++) block.add(pages[i]!.id);
  return block;
}

export function readPayload(data: DataTransfer): DragPayload | null {
  try {
    const raw = data.getData(DRAG_TYPE);
    return raw ? (JSON.parse(raw) as DragPayload) : null;
  } catch {
    return null;
  }
}
