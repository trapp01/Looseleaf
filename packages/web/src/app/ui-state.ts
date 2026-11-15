/**
 * Transient view state shared across the app: which rail panel and view are
 * showing, which dialog is open, the zoom, the drawing tool and the phone's
 * current pane. Selection lives in selection.ts; nothing here is synced.
 */
import type { ExportScopeChoice } from '../exporting/export-run.js';
import { readLocal, writeLocal } from './local-settings.js';
import { Store } from './store.js';

export type RailPanel = 'notebooks' | 'search' | 'recent';
export type RibbonTab = 'home' | 'insert' | 'draw' | 'view';
export type DrawTool = 'text' | 'pen' | 'marker' | 'highlighter' | 'eraser';
export type PhonePane = 'sections' | 'pages' | 'page';

export type Dialog =
  | { kind: 'settings' }
  | { kind: 'sync' }
  | { kind: 'export'; scope?: ExportScopeChoice; notebookId?: string; sectionId?: string; pageId?: string }
  | { kind: 'import' }
  | { kind: 'link'; href: string }
  | { kind: 'new-notebook' }
  | { kind: 'move'; notebookId: string; nodeId: string }
  | { kind: 'phone-format' };

export interface UiState {
  railPanel: RailPanel;
  view: 'page' | 'deleted';
  dialog: Dialog | null;
  /** The notebook, group or section whose name is being edited in place. */
  renaming: string | null;
  zoom: number;
  /** Bumped to ask the canvas to fit the page's width. */
  fitWidth: number;
  /** Bumped to move focus to the page title, e.g. after "New page". */
  focusTitle: number;
  /** Bumped to move focus to the search box. */
  focusSearch: number;
  ribbonTab: RibbonTab;
  tool: DrawTool;
  inkColor: string;
  inkWidth: number;
  phonePane: PhonePane;
  paneWidths: { sections: number; pages: number };
}

export const ZOOM_STEPS = [0.5, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 2, 3];
const WIDTHS_KEY = 'paneWidths';

export function createUiState(): Store<UiState> {
  const store = new Store<UiState>({
    railPanel: 'notebooks',
    view: 'page',
    dialog: null,
    renaming: null,
    zoom: 1,
    fitWidth: 0,
    focusTitle: 0,
    focusSearch: 0,
    ribbonTab: 'home',
    tool: 'text',
    inkColor: '#1f1f1f',
    inkWidth: 2,
    phonePane: 'sections',
    paneWidths: readLocal(WIDTHS_KEY, { sections: 268, pages: 238 }),
  });
  let widths = store.get().paneWidths;
  store.subscribe(() => {
    if (store.get().paneWidths !== widths) {
      widths = store.get().paneWidths;
      writeLocal(WIDTHS_KEY, widths);
    }
  });
  return store;
}

export function patchUi(store: Store<UiState>, patch: Partial<UiState>): void {
  store.update((s) => ({ ...s, ...patch }));
}

/** The zoom step after `zoom` in the direction of `step`. */
export function nextZoom(zoom: number, step: 1 | -1): number {
  if (step > 0) return ZOOM_STEPS.find((z) => z > zoom + 0.001) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1]!;
  return [...ZOOM_STEPS].reverse().find((z) => z < zoom - 0.001) ?? ZOOM_STEPS[0]!;
}
