/** The search panel: query, scope, and results grouped by section with the match highlighted. Opening a result selects its page. */
import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { SearchRegular } from '@fluentui/react-icons';
import { getNotebook, readTree } from '@looseleaf/model';
import { useServices } from '../app/services.js';
import { allSections } from '../app/selection.js';
import { useStore } from '../app/store.js';
import { patchUi } from '../app/ui-state.js';
import { groupHits, type SearchScope } from './search-index.js';

type ScopeKind = SearchScope['kind'];
const SCOPES: Array<{ kind: ScopeKind; label: string }> = [
  { kind: 'page', label: 'This page' },
  { kind: 'section', label: 'This section' },
  { kind: 'notebook', label: 'This notebook' },
  { kind: 'all', label: 'All notebooks' },
];

export function SearchPanel({ onOpenPage }: { onOpenPage?: () => void }) {
  const { search, selection, notebooks, library, ui } = useServices();
  const sel = useStore(selection);
  const progress = useStore(search.progress);
  const focusSearch = useStore(ui).focusSearch;
  const [query, setQuery] = useState('');
  const [scopeKind, setScopeKind] = useState<ScopeKind>('all');
  const deferred = useDeferredValue(query);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, [focusSearch]);

  const scope: SearchScope =
    scopeKind === 'page' && sel.pageId
      ? { kind: 'page', pageId: sel.pageId }
      : scopeKind === 'section' && sel.sectionId
        ? { kind: 'section', sectionId: sel.sectionId }
        : scopeKind === 'notebook' && sel.notebookId
          ? { kind: 'notebook', notebookId: sel.notebookId }
          : { kind: 'all' };

  const groups = useMemo(
    () => groupHits(search.search(deferred, scope)),
    // Results refill as the background index catches up.
    [search, deferred, JSON.stringify(scope), progress.indexed],
  );

  const sectionName = (notebookId: string, sectionId: string) => {
    const doc = notebooks.get(notebookId);
    const section = doc ? allSections(readTree(doc).children).find((s) => s.id === sectionId) : null;
    return `${getNotebook(library, notebookId)?.name ?? ''} › ${section?.name ?? ''}`;
  };

  return (
    <div className="pane side-panel search-panel">
      <div className="pane-header search-header">
        <label className="search-box">
          <SearchRegular />
          <input
            ref={input}
            type="search"
            placeholder="Search notes"
            aria-label="Search notes"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
      </div>
      <div className="segmented" role="radiogroup" aria-label="Search in">
        {SCOPES.map((s) => (
          <button key={s.kind} role="radio" aria-checked={scopeKind === s.kind} className={scopeKind === s.kind ? 'is-selected' : ''} onClick={() => setScopeKind(s.kind)}>
            {s.label}
          </button>
        ))}
      </div>
      {progress.indexed < progress.total && (
        <p className="search-progress">
          Reading pages for search: {progress.indexed.toLocaleString()} of {progress.total.toLocaleString()}
        </p>
      )}
      <div className="pane-list" role="list" aria-label="Search results">
        {deferred.trim() !== '' && groups.length === 0 && <p className="pane-empty">No matches.</p>}
        {groups.map((g) => (
          <section key={g.key} className="result-group">
            <h3 className="result-group-title">{sectionName(g.notebookId, g.sectionId)}</h3>
            {g.hits.map((hit) => (
              <button
                key={hit.page.pageId}
                className={`result-row ${hit.page.pageId === sel.pageId ? 'is-selected' : ''}`}
                onClick={() => {
                  selection.selectPage(hit.page.pageId, hit.page.sectionId, hit.page.notebookId);
                  patchUi(ui, { view: 'page', phonePane: 'page' });
                  onOpenPage?.();
                }}
              >
                <span className="result-title">
                  <Highlight text={hit.page.title || 'Untitled page'} query={deferred} />
                </span>
                {hit.snippet && (
                  <span className="result-snippet">
                    {hit.snippet.before}
                    <mark>{hit.snippet.match}</mark>
                    {hit.snippet.after}
                  </span>
                )}
              </button>
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}

/** The text with every occurrence of each query word marked. */
function Highlight({ text, query }: { text: string; query: string }) {
  const words = query.trim().split(/\s+/).filter(Boolean).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (words.length === 0) return <>{text}</>;
  const parts = text.split(new RegExp(`(${words.join('|')})`, 'gi'));
  return <>{parts.map((part, i) => (i % 2 === 1 ? <mark key={i}>{part}</mark> : part))}</>;
}
