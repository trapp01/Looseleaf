/**
 * Transient view state shared across the app: which rail panel and view are
 * showing, which dialog is open, the zoom, the drawing tool, the phone's
 * current pane, and on the board the page open beside it, the label filter,
 * the keyword search and the open composer. Pane widths and whether the board
 * shows beside the page are kept per device. Selection lives in selection.ts;
 * nothing here is synced.
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
  | { kind: 'phone-format' }
  | { kind: 'new-board'; notebookId: string }
  | { kind: 'board-labels' }
  | { kind: 'board-archive' }
  | { kind: 'board-shortcuts' };

export interface UiState {
  railPanel: RailPanel;
  /** The notebook view (sections, pages, page), Deleted notes, or the selected notebook's board. */
  view: 'page' | 'deleted' | 'board';
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
  /** In px. `board` is 0 until the divider beside it is dragged; the board then takes half of what the nav panes leave. */
  paneWidths: { sections: number; pages: number; board: number };
  /** The page open beside the board in the board view: a card's, or the page an Inbox line is on. */
  boardPage: string | null;
  /** In the notebook view, the board shows as a pane beside the page. */
  boardBeside: boolean;
  /** The board shows only cards carrying any of these labels; none means every card. */
  boardLabels: string[];
  /** The board shows only cards with every word of this; '' means every card. */
  boardQuery: string;
  /** Bumped to move focus to the board's search box. */
  focusBoardSearch: number;
  /** The status whose card composer is open. */
  composer: string | null;
}

export const ZOOM_STEPS = [0.5, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 2, 3];
const WIDTHS_KEY = 'paneWidths';
const BESIDE_KEY = 'boardBeside';
const DEFAULT_WIDTHS: UiState['paneWidths'] = { sections: 268, pages: 238, board: 0 };

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
    // Widths saved before a pane existed lack it, so the defaults fill the gaps.
    paneWidths: { ...DEFAULT_WIDTHS, ...readLocal<Partial<UiState['paneWidths']>>(WIDTHS_KEY, {}) },
    boardPage: null,
    boardBeside: readLocal(BESIDE_KEY, false),
    boardLabels: [],
    boardQuery: '',
    focusBoardSearch: 0,
    composer: null,
  });
  let { paneWidths: widths, boardBeside: beside } = store.get();
  store.subscribe(() => {
    const next = store.get();
    if (next.paneWidths !== widths) {
      widths = next.paneWidths;
      writeLocal(WIDTHS_KEY, widths);
    }
    if (next.boardBeside !== beside) {
      beside = next.boardBeside;
      writeLocal(BESIDE_KEY, beside);
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
