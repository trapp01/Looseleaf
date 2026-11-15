/**
 * Deleted notes: the current notebook's deleted pages, sections and section
 * groups, and deleted notebooks, each restorable. "Empty Deleted notes"
 * removes the current notebook's deleted nodes and every deleted notebook from
 * the list for good; their content stays in the stored docs.
 */
import { useState } from 'react';
import { ArrowLeftRegular, DocumentRegular, FolderRegular, NotebookFilled } from '@fluentui/react-icons';
import { colorHex, getNotebook, purgeNode, purgeNotebook, restoreNode, restoreNotebook, type NodeEntry } from '@looseleaf/model';
import { useServices } from '../app/services.js';
import { useStore } from '../app/store.js';
import { useDeletedNodes, useDeletedNotebooks } from './notebook-docs.js';

export function DeletedNotes({ onClose }: { onClose: () => void }) {
  const { selection, notebooks, library } = useServices();
  const sel = useStore(selection);
  const doc = useStore(notebooks.docs).get(sel.notebookId ?? '') ?? null;
  const nodes = useDeletedNodes(doc);
  const deletedNotebooks = useDeletedNotebooks(library);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const notebookName = sel.notebookId ? (getNotebook(library, sel.notebookId)?.name ?? '') : '';
  const itemCount = nodes.length + deletedNotebooks.length;

  const empty = () => {
    if (doc) for (const n of nodes) purgeNode(doc, n.id);
    for (const n of deletedNotebooks) purgeNotebook(library, n.id);
    setConfirming(false);
  };

  const restore = (node: NodeEntry) => {
    try {
      restoreNode(doc!, node.id);
      setError(null);
    } catch {
      setError('That page’s section no longer exists, so the page can’t be restored.');
    }
  };

  return (
    <div className="deleted-notes">
      <header className="deleted-header">
        <button className="icon-button" aria-label="Back to the page" onClick={onClose}>
          <ArrowLeftRegular />
        </button>
        <h1>Deleted notes</h1>
        <div className="spacer" />
        {itemCount > 0 &&
          (confirming ? (
            <>
              <span className="muted">
                {itemCount === 1
                  ? 'Remove this item from Deleted notes? It can’t be restored afterwards.'
                  : `Remove these ${itemCount} items from Deleted notes? They can’t be restored afterwards.`}
              </span>
              <button className="button" onClick={() => setConfirming(false)}>
                Cancel
              </button>
              <button className="button danger" onClick={empty}>
                Empty
              </button>
            </>
          ) : (
            <button className="button" onClick={() => setConfirming(true)}>
              Empty Deleted notes
            </button>
          ))}
      </header>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <section>
        <h2 className="list-heading">In {notebookName || 'this notebook'}</h2>
        {nodes.length === 0 ? (
          <p className="muted">Nothing deleted here.</p>
        ) : (
          <ul className="deleted-list">
            {nodes.map((n) => (
              <li key={n.id} className="deleted-row">
                {n.kind === 'page' ? (
                  <DocumentRegular />
                ) : n.kind === 'group' ? (
                  <FolderRegular />
                ) : (
                  <span className="section-tab" style={{ background: n.color ? colorHex(n.color) : undefined }} />
                )}
                <span className="row-label">{n.name || (n.kind === 'page' ? 'Untitled page' : 'Untitled')}</span>
                <span className="muted">{kindLabel(n)} · deleted {new Date(n.deletedAt!).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</span>
                <button className="button small" onClick={() => restore(n)}>
                  Restore
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      {deletedNotebooks.length > 0 && (
        <section>
          <h2 className="list-heading">Notebooks</h2>
          <ul className="deleted-list">
            {deletedNotebooks.map((n) => (
              <li key={n.id} className="deleted-row">
                <NotebookFilled style={{ color: colorHex(n.color) }} />
                <span className="row-label">{n.name || 'Untitled notebook'}</span>
                <span className="muted">Notebook · deleted {new Date(n.deletedAt!).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</span>
                <button className="button small" onClick={() => restoreNotebook(library, n.id)}>
                  Restore
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function kindLabel(n: NodeEntry): string {
  return n.kind === 'page' ? 'Page' : n.kind === 'section' ? 'Section' : 'Section group';
}
