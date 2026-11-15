/** The navigation area beside the rail: sections and pages, or the search or recent pages panel, with draggable dividers. */
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
        <Divider pane="pages" />
      </div>
    );
  }
  return (
    <>
      <div className="nav-pane" style={{ width: sections }}>
        <SectionsPane />
      </div>
      <Divider pane="sections" />
      <div className="nav-pane" style={{ width: pages }}>
        <PagesPane />
      </div>
      <Divider pane="pages" />
    </>
  );
}

function Divider({ pane }: { pane: keyof UiState['paneWidths'] }) {
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
        start.current = { x: event.clientX, width: ui.get().paneWidths[pane] };
      }}
      onPointerMove={(event) => {
        if (!start.current) return;
        const width = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, start.current.width + event.clientX - start.current.x));
        patchUi(ui, { paneWidths: { ...ui.get().paneWidths, [pane]: width } });
      }}
      onPointerUp={() => (start.current = null)}
      onPointerCancel={() => (start.current = null)}
    />
  );
}
