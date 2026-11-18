/**
 * The navigation area beside the rail: sections and pages, or the search or
 * recent pages panel, with draggable dividers. The board view keeps the
 * sections and takes the pages pane's place.
 */
import { useRef } from 'react';
import { useServices } from '../app/services.js';
import { useStore } from '../app/store.js';
import { patchUi, type UiState } from '../app/ui-state.js';
import { SearchPanel } from '../search/SearchPanel.js';
import { PagesPane } from './PagesPane.js';
import { RecentPanel } from './RecentPanel.js';
import { SectionsPane } from './SectionsPane.js';

const MIN_WIDTH = 160;
const MAX_WIDTH = 480;

export function NavPanel() {
  const { ui } = useServices();
  const state = useStore(ui);
  const { sections, pages } = state.paneWidths;
  if (state.railPanel !== 'notebooks') {
    return (
      <div className="nav-panel" style={{ width: sections + pages }}>
        {state.railPanel === 'search' ? <SearchPanel /> : <RecentPanel />}
        <PaneDivider pane="pages" />
      </div>
    );
  }
  return (
    <>
      <div className="nav-pane" style={{ width: sections }}>
        <SectionsPane />
      </div>
      <PaneDivider pane="sections" />
      {state.view !== 'board' && (
        <>
          <div className="nav-pane" style={{ width: pages }}>
            <PagesPane />
          </div>
          <PaneDivider pane="pages" />
        </>
      )}
    </>
  );
}

/**
 * A draggable divider that sets `pane`'s width, kept per device. A pane to
 * the divider's left grows as it moves right; one to its right (`side:
 * 'right'`) grows as it moves left. A drag starts from the pane's shown width.
 */
export function PaneDivider({
  pane,
  side = 'left',
  min = MIN_WIDTH,
  max = MAX_WIDTH,
}: {
  pane: keyof UiState['paneWidths'];
  side?: 'left' | 'right';
  min?: number;
  max?: number;
}) {
  const { ui } = useServices();
  const start = useRef<{ x: number; width: number } | null>(null);
  return (
    <div
      className="pane-divider"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize"
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        // A pane to the right can be shown at a default share of the window, so its own width is read.
        const shown = side === 'right' ? (event.currentTarget.nextElementSibling as HTMLElement | null)?.offsetWidth : undefined;
        start.current = { x: event.clientX, width: shown ?? ui.get().paneWidths[pane] };
      }}
      onPointerMove={(event) => {
        if (!start.current) return;
        const moved = (event.clientX - start.current.x) * (side === 'left' ? 1 : -1);
        const width = Math.max(min, Math.min(max, start.current.width + moved));
        patchUi(ui, { paneWidths: { ...ui.get().paneWidths, [pane]: width } });
      }}
      onPointerUp={() => (start.current = null)}
      onPointerCancel={() => (start.current = null)}
    />
  );
}
