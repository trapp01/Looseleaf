/**
 * "Move to…": the touch-friendly alternative to dragging. A page picks a
 * section; a section or section group picks the notebook's top level or a
 * section group. Moves stay inside the current notebook.
 */
import { colorHex, getNode, moveNode, type TreeChild } from '@looseleaf/model';
import { FolderRegular, NotebookFilled } from '@fluentui/react-icons';
import { Dialog } from '../app/controls.js';
import { useServices } from '../app/services.js';
import { useStore } from '../app/store.js';
import { useNotebookTree } from './notebook-docs.js';

export function MovePicker({ notebookId, nodeId, onClose }: { notebookId: string; nodeId: string; onClose: () => void }) {
  const { notebooks } = useServices();
  const doc = useStore(notebooks.docs).get(notebookId) ?? null;
  const tree = useNotebookTree(doc);
  const node = doc ? getNode(doc, nodeId) : null;
  if (!doc || !node) return null;
  const isPage = node.kind === 'page';
  const move = (parent: string | null) => {
    try {
      moveNode(doc, nodeId, { parent });
    } catch (error) {
      console.warn('That move is not possible', error);
    }
    onClose();
  };
  const rows: Array<{ id: string | null; label: string; depth: number; color?: string; group?: boolean; current: boolean }> = [];
  if (!isPage) rows.push({ id: null, label: 'Top of the notebook', depth: 0, current: node.parent === null });
  const walk = (children: TreeChild[], depth: number) => {
    for (const c of children) {
      if (c.kind === 'section') {
        if (isPage) rows.push({ id: c.id, label: c.name || 'Untitled section', depth, color: colorHex(c.color), current: node.parent === c.id });
      } else if (c.id !== nodeId) {
        rows.push({ id: c.id, label: c.name || 'Untitled section group', depth, group: true, current: node.parent === c.id });
        walk(c.children, depth + 1);
      }
    }
  };
  walk(tree.children, isPage ? 0 : 1);
  return (
    <Dialog title={`Move “${node.name || (isPage ? 'Untitled page' : 'Untitled')}” to`} onClose={onClose}>
      <div className="picker-list" role="listbox">
        {rows.map((r) => {
          const pickable = !(isPage && r.group) && !r.current;
          return (
            <button
              key={r.id ?? 'root'}
              role="option"
              aria-selected={r.current}
              className="picker-row"
              disabled={!pickable}
              style={{ paddingLeft: 12 + r.depth * 16 }}
              onClick={() => move(r.id)}
            >
              {r.color ? <span className="section-tab" style={{ background: r.color }} /> : r.id === null ? <NotebookFilled /> : <FolderRegular />}
              <span className="row-label">{r.label}</span>
              {r.current && <span className="muted">Current</span>}
            </button>
          );
        })}
      </div>
    </Dialog>
  );
}
