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
  pageDocId,
  readTree,
  listNotebooks,
} from '@looseleaf/model';
import { CommandTable, type AppActions } from '../commands/command-table.js';
import { BlobUrlCache, retryMissingOnSync } from '../canvas/blob-urls.js';
import { pickFiles } from '../canvas/files.js';
import { placeFiles } from '../canvas/insert.js';
import type { PageSession } from '../canvas/page-session.js';
import { deliverExport } from '../exporting/export-run.js';
import { NotebookDocs } from '../nav/notebook-docs.js';
import { RecentPages } from '../nav/recent.js';
import { SearchIndex, type SearchablePage } from '../search/search-index.js';
import { allSections, SelectionStore } from './selection.js';
import { Store } from './store.js';
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
  recent: RecentPages;
  commands: CommandTable;
}

export const ServicesContext = createContext<Services | null>(null);

export function useServices(): Services {
  const services = useContext(ServicesContext);
  if (!services) throw new Error('useServices needs a ServicesContext provider');
  return services;
}

export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

export async function createServices(client: SyncClient): Promise<Services> {
  const library = await client.openDoc(LIBRARY_DOC_ID);
  const notebooks = new NotebookDocs(client, library);
  const services: Services = {
    client,
    library,
    notebooks,
    selection: new SelectionStore(),
    ui: createUiState(),
    activeEditor: new Store<Editor | null>(null),
    page: new Store<PageSession | null>(null),
    blobs: new BlobUrlCache({ getBlob: (hash) => client.getBlob(hash) }),
    search: new SearchIndex({
      listPages: () => searchablePages(notebooks),
      pageText: async (pageId) => {
        const doc = await client.openDoc(pageDocId(pageId));
        try {
          return extractPageText(doc);
        } finally {
          client.releaseDoc(pageDocId(pageId));
        }
      },
    }),
    recent: new RecentPages(),
    commands: null as unknown as CommandTable,
  };
  services.commands = new CommandTable(() => ({ editor: liveEditor(services), app: appActions(services) }), isMac);
  retryMissingOnSync(client, services.blobs);
  return services;
}

function liveEditor(services: Services): Editor | null {
  const editor = services.activeEditor.get();
  return editor && !editor.isDestroyed && services.ui.get().view === 'page' ? editor : null;
}

function searchablePages(notebooks: NotebookDocs): SearchablePage[] {
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
    hasPage: () => s.page.get() !== null && s.ui.get().view === 'page',
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
