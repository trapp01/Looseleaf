/** The left rail: notebooks, search and recent pages at the top, settings at the bottom. */
import { HistoryRegular, NotebookRegular, SearchRegular, SettingsRegular } from '@fluentui/react-icons';
import { useServices } from '../app/services.js';
import { useStore } from '../app/store.js';
import { patchUi, type RailPanel } from '../app/ui-state.js';

const ITEMS: Array<{ panel: RailPanel; label: string; Icon: typeof NotebookRegular }> = [
  { panel: 'notebooks', label: 'Notebooks', Icon: NotebookRegular },
  { panel: 'search', label: 'Search', Icon: SearchRegular },
  { panel: 'recent', label: 'Recent pages', Icon: HistoryRegular },
];

export function Rail() {
  const { ui, commands } = useServices();
  const state = useStore(ui);
  return (
    <nav className="rail" aria-label="Navigation">
      {ITEMS.map(({ panel, label, Icon }) => (
        <button
          key={panel}
          className={`rail-item ${state.railPanel === panel ? 'is-selected' : ''}`}
          aria-label={label}
          title={panel === 'search' ? commands.tooltip('find') : label}
          aria-pressed={state.railPanel === panel}
          onClick={() => (panel === 'search' ? commands.run('find') : patchUi(ui, { railPanel: panel }))}
        >
          <Icon />
        </button>
      ))}
      <div className="rail-spacer" />
      <button className="rail-item" aria-label="Settings" title="Settings" onClick={() => commands.run('settings')}>
        <SettingsRegular />
      </button>
    </nav>
  );
}
