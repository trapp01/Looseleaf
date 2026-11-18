/**
 * The bar above the board: "Board" and the board key, the search box (`/`
 * focuses it, Escape clears it), the label filter with the count of cards
 * showing and a way to clear both, and the board's Labels and Archived
 * items. Beside a page it also has a button that closes the board pane.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ArchiveRegular, DismissRegular, FilterRegular, SearchRegular, TagMultipleRegular } from '@fluentui/react-icons';
import { shownCards } from '@looseleaf/model';
import { IconButton, Popover } from '../app/controls.js';
import { useServices } from '../app/services.js';
import { useStore } from '../app/store.js';
import { patchUi } from '../app/ui-state.js';
import { useCardFilter } from './filter.js';
import { LabelChip } from './LabelChip.js';
import type { CurrentBoard } from './live-board.js';

export function BoardBar({ current, onClose }: { current: CurrentBoard; onClose?: () => void }) {
  const { ui } = useServices();
  const { board } = current;
  const { labelIds: filter, query, matches } = useCardFilter(board);
  const focusSearch = useStore(ui).focusBoardSearch;
  const search = useRef<HTMLInputElement>(null);
  const filterButton = useRef<HTMLButtonElement>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const firstFocus = useRef(focusSearch);
  useEffect(() => {
    if (focusSearch !== firstFocus.current) search.current?.focus();
  }, [focusSearch]);

  const counts = useMemo(() => {
    const cards = shownCards(board);
    return { shown: matches === null ? cards.length : cards.filter((card) => matches.has(card.id)).length, total: cards.length };
  }, [board, matches]);
  const toggle = (labelId: string) =>
    patchUi(ui, { boardLabels: filter.includes(labelId) ? filter.filter((id) => id !== labelId) : [...filter, labelId] });
  const onSearchKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    if (query !== '') patchUi(ui, { boardQuery: '' });
    else search.current?.blur();
  };

  return (
    <div className="board-bar">
      <h1 className="board-title">
        Board <span className="board-key">{board.meta.key}</span>
      </h1>
      <label className="search-box board-search">
        <SearchRegular aria-hidden="true" />
        <input
          ref={search}
          type="search"
          aria-label="Search cards"
          placeholder="Search cards"
          value={query}
          onChange={(e) => patchUi(ui, { boardQuery: e.target.value })}
          onKeyDown={onSearchKey}
          spellCheck={false}
        />
        <kbd className="search-hint" aria-hidden="true">
          /
        </kbd>
      </label>
      <button
        ref={filterButton}
        type="button"
        className={`button small filter-button ${filter.length > 0 ? 'is-on' : ''}`}
        onClick={() => setFilterOpen((open) => !open)}
        aria-expanded={filterOpen}
      >
        <FilterRegular aria-hidden="true" />
        {filter.length > 0 ? `Filter (${filter.length})` : 'Filter'}
      </button>
      {matches !== null && (
        <span className="filter-status">
          <span className="filter-count" aria-live="polite">
            {counts.shown} of {counts.total} cards
          </span>
          <button type="button" className="button small" onClick={() => patchUi(ui, { boardLabels: [], boardQuery: '' })}>
            <DismissRegular aria-hidden="true" />
            Clear filter
          </button>
        </span>
      )}
      <span className="spacer" />
      <button type="button" className="button small" onClick={() => patchUi(ui, { dialog: { kind: 'board-labels' } })}>
        <TagMultipleRegular aria-hidden="true" />
        Labels
      </button>
      <button type="button" className="button small" onClick={() => patchUi(ui, { dialog: { kind: 'board-archive' } })}>
        <ArchiveRegular aria-hidden="true" />
        Archived items
      </button>
      {onClose && (
        <IconButton label="Close board" onClick={onClose}>
          <DismissRegular />
        </IconButton>
      )}
      {filterOpen && (
        <Popover anchor={filterButton.current} onClose={() => setFilterOpen(false)} className="label-filter">
          <div role="dialog" aria-label="Filter by label" className="label-picker-body">
            {board.labels.length === 0 ? (
              <p className="muted popover-note">This board has no labels yet. Add them under Labels.</p>
            ) : (
              <ul className="check-list">
                {board.labels.map((label) => (
                  <li key={label.id}>
                    <label className="check-row">
                      <input type="checkbox" checked={filter.includes(label.id)} onChange={() => toggle(label.id)} />
                      <LabelChip label={label} />
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Popover>
      )}
    </div>
  );
}
