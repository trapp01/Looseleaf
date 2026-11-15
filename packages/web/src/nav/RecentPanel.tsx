/** Recent pages from every notebook, newest first; pages that are gone are left out. */
import { getNotebook, readTree } from '@looseleaf/model';
import { useServices } from '../app/services.js';
import { allSections } from '../app/selection.js';
import { useStore } from '../app/store.js';
import { patchUi } from '../app/ui-state.js';
import { useYValue } from '../app/yjs-hooks.js';
import { describeTime } from '../sync-ui/status-label.js';

export function RecentPanel({ onOpenPage }: { onOpenPage?: () => void }) {
  const { recent, notebooks, library, selection, ui } = useServices();
  const visits = useStore(recent);
  const docs = useStore(notebooks.docs);
  const sel = useStore(selection);
  const libraryVersion = useYValue(library, () => ({}));
  const rows = visits.flatMap((v) => {
    const doc = docs.get(v.notebookId);
    const notebook = getNotebook(library, v.notebookId);
    if (!doc || !notebook || notebook.deletedAt !== null) return [];
    for (const section of allSections(readTree(doc).children)) {
      const page = section.pages.find((p) => p.id === v.pageId);
      if (page) return [{ ...v, sectionId: section.id, title: page.title, where: `${notebook.name} › ${section.name}` }];
    }
    return [];
  });
  void libraryVersion;
  return (
    <div className="pane side-panel">
      <div className="pane-header">
        <h2 className="pane-title">Recent pages</h2>
      </div>
      <div className="pane-list" role="list">
        {rows.length === 0 && <p className="pane-empty">Pages you open show up here.</p>}
        {rows.map((r) => (
          <button
            key={r.pageId}
            role="listitem"
            className={`result-row ${r.pageId === sel.pageId ? 'is-selected' : ''}`}
            onClick={() => {
              selection.selectPage(r.pageId, r.sectionId, r.notebookId);
              patchUi(ui, { view: 'page', phonePane: 'page' });
              onOpenPage?.();
            }}
          >
            <span className="result-title">{r.title || 'Untitled page'}</span>
            <span className="result-where">
              {r.where} · {describeTime(r.at)}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
