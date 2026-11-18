/**
 * The title bar: undo and redo at the left, the title centred, Export and the
 * sync status at the right. The title names the page shown and its notebook;
 * in the board view with no page open beside the board it names the board.
 */
import { ArrowDownloadRegular, ArrowRedoRegular, ArrowUndoRegular } from '@fluentui/react-icons';
import { getNode, getNotebook } from '@looseleaf/model';
import { useServices } from './services.js';
import { useStore } from './store.js';
import { useYValue } from './yjs-hooks.js';
import { SyncStatusControl } from '../sync-ui/SyncStatusControl.js';
import { IconButton } from './controls.js';
import { usePageHistory } from '../canvas/use-page.js';

export function TitleBar() {
  const { selection, notebooks, library, commands, ui } = useServices();
  const sel = useStore(selection);
  const { view, boardPage } = useStore(ui);
  const doc = useStore(notebooks.docs).get(sel.notebookId ?? '') ?? null;
  const shownPage = view === 'board' ? boardPage : sel.pageId;
  const pageTitle = useYValue(doc, () => (doc && shownPage ? (getNode(doc, shownPage)?.name ?? '') : ''), shownPage);
  const title = shownPage ? pageTitle || 'Untitled page' : view === 'board' ? 'Board' : '';
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
        {title ? <span className="title-page">{title}</span> : null}
        {notebookName ? <span className="title-notebook">{title ? ' · ' : ''}{notebookName}</span> : null}
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
