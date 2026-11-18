/**
 * The phone layout (under 768 px): one pane at a time, drilling down from
 * sections to pages to the page, or from sections to the board to a page
 * opened from it. The page pane has a back arrow, the title, a more-actions
 * menu, the canvas, and the formatting bar docked above the on-screen
 * keyboard.
 */
import { useEffect, useRef, type ReactNode } from 'react';
import { ArrowLeftRegular, HistoryRegular, MoreHorizontalRegular, SearchRegular, SettingsRegular } from '@fluentui/react-icons';
import { deleteNode, getNode } from '@looseleaf/model';
import { useServices } from '../app/services.js';
import { useStore } from '../app/store.js';
import { patchUi } from '../app/ui-state.js';
import { useYValue } from '../app/yjs-hooks.js';
import { showMenu } from '../nav/context-menu.js';
import { PagesPane } from '../nav/PagesPane.js';
import { RecentPanel } from '../nav/RecentPanel.js';
import { SectionsPane } from '../nav/SectionsPane.js';
import { SearchPanel } from '../search/SearchPanel.js';
import { SyncStatusControl } from '../sync-ui/SyncStatusControl.js';
import { FormatBar } from './FormatBar.js';
import { useKeyboardInset } from './viewport.js';

export function PhoneShell({ main }: { main: ReactNode }) {
  const { ui, selection, notebooks, commands } = useServices();
  const state = useStore(ui);
  const sel = useStore(selection);
  const doc = useStore(notebooks.docs).get(sel.notebookId ?? '') ?? null;
  const title = useYValue(doc, () => (doc && sel.pageId ? (getNode(doc, sel.pageId)?.name ?? '') : ''), sel.pageId);
  // A page opened from the board shows over it; back returns to the board.
  const boardPage = state.view === 'board' ? state.boardPage : null;
  const boardPageTitle = useYValue(doc, () => (doc && boardPage ? (getNode(doc, boardPage)?.name ?? '') : ''), boardPage);
  const go = (phonePane: typeof state.phonePane) => patchUi(ui, { phonePane });
  useKeyboardInset();
  const more = useRef<HTMLButtonElement>(null);

  // Drawing needs the Draw tab on a wide screen; the phone canvas is always in text mode.
  useEffect(() => {
    if (state.tool !== 'text') patchUi(ui, { tool: 'text' });
  }, [state.tool, ui]);

  if (state.phonePane === 'pages') {
    return (
      <div className="phone-pane">
        <PagesPane onBack={() => go('sections')} />
      </div>
    );
  }

  if (state.phonePane === 'page') {
    const openMore = () => {
      const r = more.current!.getBoundingClientRect();
      showMenu(r.right, r.bottom, [
        { label: 'Undo', disabled: !commands.isEnabled('undo'), onSelect: () => commands.run('undo') },
        { label: 'Redo', disabled: !commands.isEnabled('redo'), onSelect: () => commands.run('redo') },
        'separator',
        { label: 'Put on board', disabled: !commands.isEnabled('put-on-board'), onSelect: () => commands.run('put-on-board') },
        { label: 'Export page…', disabled: !sel.pageId || state.view !== 'page', onSelect: () => patchUi(ui, { dialog: { kind: 'export', scope: 'page' } }) },
        { label: 'Deleted notes', onSelect: () => commands.run('deleted-notes') },
        'separator',
        {
          label: 'Delete page',
          danger: true,
          disabled: !doc || !sel.pageId || state.view !== 'page',
          onSelect: () => {
            deleteNode(doc!, sel.pageId!);
            go('pages');
          },
        },
      ]);
    };
    return (
      <div className="phone-pane phone-page">
        <header className="phone-header">
          {boardPage ? (
            <button className="icon-button" aria-label="Back to board" onClick={() => patchUi(ui, { boardPage: null })}>
              <ArrowLeftRegular />
            </button>
          ) : state.view === 'board' ? (
            <button className="icon-button" aria-label="Back to sections" onClick={() => (patchUi(ui, { view: 'page', boardPage: null }), go('sections'))}>
              <ArrowLeftRegular />
            </button>
          ) : (
            <button className="icon-button" aria-label="Back to pages" onClick={() => (patchUi(ui, { view: 'page' }), go('pages'))}>
              <ArrowLeftRegular />
            </button>
          )}
          <span className="phone-title">
            {state.view === 'deleted' ? 'Deleted notes' : boardPage ? boardPageTitle || 'Untitled page' : state.view === 'board' ? 'Board' : title || 'Untitled page'}
          </span>
          <button ref={more} className="icon-button" aria-label="More actions" onClick={openMore}>
            <MoreHorizontalRegular />
          </button>
        </header>
        <div className="phone-main">{main}</div>
        {((state.view === 'page' && sel.pageId) || boardPage) && <FormatBar />}
      </div>
    );
  }

  return (
    <div className="phone-pane">
      <PhoneTopBar />
      {state.railPanel === 'search' ? (
        <>
          <button className="phone-back-link" onClick={() => patchUi(ui, { railPanel: 'notebooks' })}>
            <ArrowLeftRegular /> Notebooks
          </button>
          <SearchPanel />
        </>
      ) : state.railPanel === 'recent' ? (
        <>
          <button className="phone-back-link" onClick={() => patchUi(ui, { railPanel: 'notebooks' })}>
            <ArrowLeftRegular /> Notebooks
          </button>
          <RecentPanel />
        </>
      ) : (
        <SectionsPane onOpenSection={() => go('pages')} onOpenBoard={() => go('page')} />
      )}
    </div>
  );
}

/** The sections pane's top bar: sync status, search, recent pages and settings. */
export function PhoneTopBar() {
  const { ui, commands } = useServices();
  const railPanel = useStore(ui).railPanel;
  return (
    <header className="phone-header phone-top">
      <SyncStatusControl compact />
      <div className="spacer" />
      <button className={`icon-button ${railPanel === 'search' ? 'is-active' : ''}`} aria-label="Search" onClick={() => commands.run('find')}>
        <SearchRegular />
      </button>
      <button
        className={`icon-button ${railPanel === 'recent' ? 'is-active' : ''}`}
        aria-label="Recent pages"
        onClick={() => patchUi(ui, { railPanel: railPanel === 'recent' ? 'notebooks' : 'recent' })}
      >
        <HistoryRegular />
      </button>
      <button className="icon-button" aria-label="Settings" onClick={() => commands.run('settings')}>
        <SettingsRegular />
      </button>
    </header>
  );
}
