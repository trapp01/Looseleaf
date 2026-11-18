/**
 * The app once first run is done: the desktop layout (title bar, ribbon,
 * rail, sections, pages, canvas) or the phone drill-down, plus the dialogs.
 * It also wires the things that span the app: keeping the selection valid
 * against the live tree, keyboard shortcuts and native menu commands through
 * the command table, recent pages, keeping the search index fresh, opening the
 * page a page address names, and asking
 * before the tab closes while changes are not yet stored.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { shell } from '../shell-bridge.js';
import { MENU_COMMANDS } from '../commands/command-table.js';
import { PageView } from '../canvas/PageView.js';
import { Dialogs } from './Dialogs.js';
import { guardLeaving } from './leave-guard.js';
import { useServices } from './services.js';
import { useStore } from './store.js';
import { patchUi } from './ui-state.js';
import { TitleBar } from './TitleBar.js';
import { Ribbon } from '../ribbon/Ribbon.js';
import { Rail } from '../nav/Rail.js';
import { NavPanel } from '../nav/NavPanel.js';
import { DeletedNotes } from '../nav/DeletedNotes.js';
import { EmptyLibrary, EmptySection } from '../nav/EmptyStates.js';
import { useNotebooks, useNotebookTree } from '../nav/notebook-docs.js';
import { useOpenPageAddress } from '../nav/open-page-address.js';
import { ContextMenuHost } from '../nav/context-menu.js';
import { PhoneShell, PhoneTopBar } from '../phone/PhoneShell.js';
import { useSearchIndexing } from '../search/use-search-indexing.js';
import { allSections } from './selection.js';

const PHONE_QUERY = '(max-width: 767px)';

export function useIsPhone(): boolean {
  return useSyncExternalStore(
    (notify) => {
      const query = window.matchMedia(PHONE_QUERY);
      query.addEventListener('change', notify);
      return () => query.removeEventListener('change', notify);
    },
    () => window.matchMedia(PHONE_QUERY).matches,
  );
}

export function AppShell({ persistent }: { persistent: boolean }) {
  const services = useServices();
  const { selection, notebooks, library, commands, ui, recent } = services;
  const phone = useIsPhone();
  const notebookList = useNotebooks(library);
  const sel = useStore(selection);
  const docs = useStore(notebooks.docs);
  const doc = sel.notebookId ? (docs.get(sel.notebookId) ?? null) : null;
  const tree = useNotebookTree(doc);

  useEffect(() => {
    selection.reconcile(
      notebookList.map((n) => n.id),
      doc ? tree : null,
    );
  }, [selection, notebookList, doc, tree]);

  useEffect(() => {
    if (sel.notebookId && sel.sectionId && sel.pageId) {
      recent.visit({ notebookId: sel.notebookId, sectionId: sel.sectionId, pageId: sel.pageId });
    }
  }, [recent, sel.notebookId, sel.sectionId, sel.pageId]);

  useSearchIndexing(services);
  useOpenPageAddress(services);

  const { client } = services;
  useEffect(() => guardLeaving(() => client.status.unstoredDocs > 0), [client]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const id = commands.commandForKey(event);
      if (!id) return;
      const target = event.target as HTMLElement | null;
      const inField = !!target?.closest?.('input, textarea, select');
      // Inputs keep their own undo and formatting keys; only app-wide commands reach past them.
      const appWide = id.startsWith('new-') || id === 'find' || id === 'settings';
      if (inField && !appWide) return;
      if (commands.run(id) || commands.get(id).needsEditor) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [commands]);

  useEffect(
    () =>
      shell()?.onMenuCommand((command) => {
        // Native menus send undo and redo as commands; a focused text field keeps its own history.
        const field = document.activeElement?.closest?.('input, textarea');
        if (field && (command === 'undo' || command === 'redo')) return void document.execCommand(command);
        commands.run(MENU_COMMANDS[command]);
      }),
    [commands],
  );

  const view = useStore(ui).view;
  const hasSections = allSections(tree.children).length > 0;
  let main;
  if (view === 'deleted') main = <DeletedNotes onClose={() => patchUi(ui, { view: 'page' })} />;
  else if (sel.pageId && doc) main = <PageView key={sel.pageId} notebookId={sel.notebookId!} pageId={sel.pageId} notebookDoc={doc} />;
  else main = <EmptySection hasSections={hasSections} />;

  const body =
    notebookList.length === 0 ? (
      phone ? (
        <div className="phone-pane">
          <PhoneTopBar />
          <EmptyLibrary />
        </div>
      ) : (
        <EmptyLibrary />
      )
    ) : phone ? (
      <PhoneShell main={main} />
    ) : (
      <div className="workspace">
        <Rail />
        <NavPanel />
        <main className="main-area">{main}</main>
      </div>
    );

  return (
    <div className={`app ${phone ? 'is-phone' : 'is-desktop'}`} data-shell={shell()?.platform ?? 'browser'}>
      {!phone && <TitleBar />}
      {!phone && notebookList.length > 0 && <Ribbon />}
      {!persistent && <div className="banner">This browser isn’t keeping data for this site, so notes last until the tab closes.</div>}
      {body}
      <Dialogs />
      <ContextMenuHost />
    </div>
  );
}
