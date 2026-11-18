/**
 * The app's long-lived objects, created once per session over one sync
 * client, and the actions the command table runs. Components get them through
 * `useServices()`; nothing else holds global state.
 */
import { createContext, useContext } from 'react';
import type { Editor } from '@tiptap/core';
import type * as Y from 'yjs';
import type { SyncClient } from '@looseleaf/sync';
import {
  createGroup,
  createPage,
  createSection,
  extractPageText,
  getNode,
  LIBRARY_DOC_ID,
  listTodoLines,
  pageDocId,
  putOnBoard,
  readTree,
  cardPageIds,
  listNotebooks,
  type DocAccess,
} from '@looseleaf/model';
import { CommandTable, type AppActions } from '../commands/command-table.js';
import { replicaDocAccess } from '../board/doc-access.js';
import { liveCard, LiveBoard } from '../board/live-board.js';
import { BlobUrlCache, retryMissingOnSync } from '../canvas/blob-urls.js';
import { pickFiles } from '../canvas/files.js';
import { placeFiles } from '../canvas/insert.js';
import type { PageSession } from '../canvas/page-session.js';
import { deliverExport } from '../exporting/export-run.js';
import { startMirror, type MirrorRunner } from '../mirror/mirror-runner.js';
import { NotebookDocs } from '../nav/notebook-docs.js';
import { RecentPages } from '../nav/recent.js';
import { SearchIndex, type SearchablePage } from '../search/search-index.js';
import type { TodoLineIndex } from '../search/todo-line-index.js';
import { readLocal, writeLocal } from './local-settings.js';
import { allSections, SelectionStore } from './selection.js';
import { Store } from './store.js';
import { Toasts } from './toasts.js';
import { createUiState, nextZoom, patchUi, type UiState } from './ui-state.js';

export interface Services {
  client: SyncClient;
  library: Y.Doc;
  notebooks: NotebookDocs;
  selection: SelectionStore;
  ui: Store<UiState>;
  /** The text editor the caret is in, or was last in, on the open page. */
  activeEditor: Store<Editor | null>;
  page: Store<PageSession | null>;
  blobs: BlobUrlCache;
  search: SearchIndex;
  /** Every page's To Do lines, kept by the search pass; the same object as `search.lines`. */
  todoLines: TodoLineIndex;
  /** The selected notebook's board. */
  boards: LiveBoard;
  /** The model's cross-doc access over this replica, for adding and labelling cards. */
  access: DocAccess;
  /** The name recorded on this device's board changes (the actor). */
  actor: Store<string>;
  toasts: Toasts;
  recent: RecentPages;
  commands: CommandTable;
  /** The mirror kept in the folder chosen in the desktop app; null outside it. */
  mirror: MirrorRunner | null;
}

export const ServicesContext = createContext<Services | null>(null);

export function useServices(): Services {
  const services = useContext(ServicesContext);
  if (!services) throw new Error('useServices needs a ServicesContext provider');
  return services;
}

export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** A store whose value is read from and written back to localStorage under `key`. */
function localStore<T>(key: string, fallback: T): Store<T> {
  const store = new Store<T>(readLocal(key, fallback));
  store.subscribe(() => writeLocal(key, store.get()));
  return store;
}

const NO_PAGES: ReadonlySet<string> = new Set();

export async function createServices(client: SyncClient): Promise<Services> {
  const library = await client.openDoc(LIBRARY_DOC_ID);
  const notebooks = new NotebookDocs(client, library);
  const selection = new SelectionStore();
  let boards: LiveBoard | null = null;
  const search = new SearchIndex({
    listPages: () => searchablePages(notebooks),
    firstPages: () => {
      const current = boards?.current.get();
      return current ? cardPageIds(current.board) : NO_PAGES;
    },
    readPage: async (pageId) => {
      const doc = await client.openDoc(pageDocId(pageId));
      try {
        return { text: extractPageText(doc), lines: listTodoLines(doc) };
      } finally {
        client.releaseDoc(pageDocId(pageId));
      }
    },
  });
  const services: Services = {
    client,
    library,
    notebooks,
    selection,
    ui: createUiState(),
    activeEditor: new Store<Editor | null>(null),
    page: new Store<PageSession | null>(null),
    blobs: new BlobUrlCache({ getBlob: (hash) => client.getBlob(hash) }),
    search,
    todoLines: search.lines,
    boards: (boards = new LiveBoard(client, selection, notebooks)),
    access: replicaDocAccess(client),
    actor: localStore('actor', ''),
    toasts: new Toasts(),
    recent: new RecentPages(),
    commands: null as unknown as CommandTable,
    mirror: startMirror(client),
  };
  services.commands = new CommandTable(() => ({ editor: liveEditor(services), app: appActions(services) }), isMac);
  retryMissingOnSync(client, services.blobs);
  return services;
}

/** The open page shows in the notebook view and, for a card, beside the board; never under Deleted notes. */
function pageShowing(services: Services): boolean {
  return services.page.get() !== null && services.ui.get().view !== 'deleted';
}

function liveEditor(services: Services): Editor | null {
  const editor = services.activeEditor.get();
  return editor && !editor.isDestroyed && pageShowing(services) ? editor : null;
}

/** The open page when it can go on its notebook's board: the notebook has one and the page is not a card on it. */
function pageForBoard(s: Services): string | null {
  const session = s.page.get();
  const current = s.boards.current.get();
  if (!session || !pageShowing(s) || !current || session.notebookId !== current.notebookId) return null;
  return liveCard(current.board, session.pageId) ? null : session.pageId;
}

/** Every page of every live notebook that is open, with the notebook and section it sits in. */
export function searchablePages(notebooks: NotebookDocs): SearchablePage[] {
  const pages: SearchablePage[] = [];
  const live = new Set(listNotebooks(notebooks.library).map((n) => n.id));
  for (const [notebookId, doc] of notebooks.docs.get()) {
    if (!live.has(notebookId)) continue;
    for (const section of allSections(readTree(doc).children)) {
      for (const page of section.pages) {
        pages.push({ pageId: page.id, notebookId, sectionId: section.id, title: page.title, modifiedAt: page.modifiedAt });
      }
    }
  }
  return pages;
}

/** "New Section 1", "New Section 2", … the first name not taken. */
export function nextName(base: string, taken: string[]): string {
  for (let n = 1; ; n++) if (!taken.includes(`${base} ${n}`)) return `${base} ${n}`;
}

export function appActions(s: Services): AppActions {
  const ui = (patch: Partial<UiState>) => patchUi(s.ui, patch);
  const notebookDoc = () => s.notebooks.get(s.selection.get().notebookId);

  const newSection = (): string | null => {
    const doc = notebookDoc();
    if (!doc) {
      ui({ dialog: { kind: 'new-notebook' } });
      return null;
    }
    const names = allSections(readTree(doc).children).map((x) => x.name);
    const id = createSection(doc, { name: nextName('New Section', names), parent: null });
    s.selection.selectSection(id);
    ui({ renaming: id, view: 'page', railPanel: 'notebooks', phonePane: 'sections' });
    return id;
  };

  const placePicked = async (accept: string) => {
    const session = s.page.get();
    if (!session) return;
    const files = await pickFiles(accept);
    if (files.length > 0) await placeFiles(s, session, files, { editor: liveEditor(s) });
  };

  return {
    hasPage: () => pageShowing(s),
    canPutOnBoard: () => pageForBoard(s) !== null,
    putOnBoard: () => {
      const pageId = pageForBoard(s);
      const current = s.boards.current.get();
      if (pageId && current) putOnBoard(current.doc, pageId, { by: s.actor.get() });
    },
    canShowBoardBeside: () => s.ui.get().view === 'page' && s.boards.current.get()?.notebookId === s.selection.get().notebookId,
    boardBesideOpen: () => s.ui.get().boardBeside,
    toggleBoardBeside: () => ui({ boardBeside: !s.ui.get().boardBeside }),
    newPage: () => {
      const doc = notebookDoc();
      if (!doc) return void ui({ dialog: { kind: 'new-notebook' } });
      const sectionId = s.selection.get().sectionId ?? newSection();
      if (!sectionId) return;
      const id = createPage(doc, { section: sectionId, title: '' });
      s.selection.selectPage(id, sectionId);
      ui({ view: 'page', phonePane: 'page', focusTitle: s.ui.get().focusTitle + 1, renaming: null });
    },
    newSection: () => void newSection(),
    newSectionGroup: () => {
      const doc = notebookDoc();
      if (!doc) return void ui({ dialog: { kind: 'new-notebook' } });
      const id = createGroup(doc, { name: 'New Section Group', parent: null });
      ui({ renaming: id, railPanel: 'notebooks' });
    },
    newNotebook: () => ui({ dialog: { kind: 'new-notebook' } }),
    openImport: () => ui({ dialog: { kind: 'import' } }),
    openExport: () => ui({ dialog: { kind: 'export' } }),
    savePdf: () => {
      const { pageId } = s.selection.get();
      const title = (pageId && notebookDoc() ? getNode(notebookDoc()!, pageId)?.name : '') || 'Untitled page';
      void deliverExport({ kind: 'print', name: `${title.replace(/[\\/:*?"<>|]+/g, '-')}.pdf` });
    },
    print: () => window.print(),
    canUndo: () => (s.page.get()?.undo.undoStack.length ?? 0) > 0,
    canRedo: () => (s.page.get()?.undo.redoStack.length ?? 0) > 0,
    undo: () => void s.page.get()?.undo.undo(),
    redo: () => void s.page.get()?.undo.redo(),
    find: () => ui({ railPanel: 'search', focusSearch: s.ui.get().focusSearch + 1, phonePane: 'sections' }),
    zoomBy: (step) => ui({ zoom: nextZoom(s.ui.get().zoom, step) }),
    zoomReset: () => ui({ zoom: 1 }),
    zoomPageWidth: () => ui({ fitWidth: s.ui.get().fitWidth + 1 }),
    showDeletedNotes: () => ui({ view: 'deleted', phonePane: 'page' }),
    openSettings: () => ui({ dialog: { kind: 'settings' } }),
    insertPicture: () => void placePicked('image/*'),
    insertFile: () => void placePicked('*/*'),
    openLinkDialog: () => {
      const editor = liveEditor(s);
      ui({ dialog: { kind: 'link', href: String(editor?.getAttributes('link').href ?? '') } });
    },
  };
}
