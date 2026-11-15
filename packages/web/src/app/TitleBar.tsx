/** The title bar: undo and redo at the left, the page title centred, Export and the sync status at the right. */
import { ArrowDownloadRegular, ArrowRedoRegular, ArrowUndoRegular } from '@fluentui/react-icons';
import { getNode, getNotebook } from '@looseleaf/model';
import { useServices } from './services.js';
import { useStore } from './store.js';
import { useYValue } from './yjs-hooks.js';
import { SyncStatusControl } from '../sync-ui/SyncStatusControl.js';
import { IconButton } from './controls.js';
import { usePageHistory } from '../canvas/use-page.js';

export function TitleBar() {
  const { selection, notebooks, library, commands } = useServices();
  const sel = useStore(selection);
  const doc = useStore(notebooks.docs).get(sel.notebookId ?? '') ?? null;
  const title = useYValue(doc, () => (doc && sel.pageId ? (getNode(doc, sel.pageId)?.name ?? '') : ''), sel.pageId);
  const notebookName = useYValue(library, () => (sel.notebookId ? (getNotebook(library, sel.notebookId)?.name ?? '') : ''), sel.notebookId);
  usePageHistory();

  return (
    <header className="title-bar">
      <div className="title-bar-left">
        <IconButton label={commands.tooltip('undo')} disabled={!commands.isEnabled('undo')} onClick={() => commands.run('undo')}>
          <ArrowUndoRegular />
        </IconButton>
        <IconButton label={commands.tooltip('redo')} disabled={!commands.isEnabled('redo')} onClick={() => commands.run('redo')}>
          <ArrowRedoRegular />
        </IconButton>
      </div>
      <div className="title-bar-title" title={title}>
        {sel.pageId ? <span className="title-page">{title || 'Untitled page'}</span> : null}
        {notebookName ? <span className="title-notebook">{sel.pageId ? ' · ' : ''}{notebookName}</span> : null}
      </div>
      <div className="title-bar-right">
        <button className="title-button" onClick={() => commands.run('export')} title="Export">
          <ArrowDownloadRegular />
          <span>Export</span>
        </button>
        <SyncStatusControl />
      </div>
    </header>
  );
}
