/**
 * The ribbon: the tab row (Home, Insert, Draw, View) and the white card of
 * command groups under it. It re-renders as the selection moves so active
 * marks, the current font and the current style show, at most once a frame.
 */
import { useEffect, useState } from 'react';
import type { Editor } from '@tiptap/core';
import { useServices } from '../app/services.js';
import { useStore } from '../app/store.js';
import { patchUi, type RibbonTab } from '../app/ui-state.js';
import { usePageHistory } from '../canvas/use-page.js';
import { DrawTab } from './DrawTab.js';
import { HomeTab } from './HomeTab.js';
import { InsertTab } from './InsertTab.js';
import { ViewTab } from './ViewTab.js';

const TABS: Array<{ id: RibbonTab; label: string }> = [
  { id: 'home', label: 'Home' },
  { id: 'insert', label: 'Insert' },
  { id: 'draw', label: 'Draw' },
  { id: 'view', label: 'View' },
];

/** Re-renders the caller when the active editor's selection, marks or focus change; returns the editor. */
export function useEditorState(): Editor | null {
  const { activeEditor } = useServices();
  const editor = useStore(activeEditor);
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!editor) return;
    let frame = 0;
    const bump = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setTick((n) => n + 1));
    };
    editor.on('transaction', bump);
    editor.on('focus', bump);
    editor.on('blur', bump);
    return () => {
      cancelAnimationFrame(frame);
      editor.off('transaction', bump);
      editor.off('focus', bump);
      editor.off('blur', bump);
    };
  }, [editor]);
  return editor && !editor.isDestroyed ? editor : null;
}

export function Ribbon() {
  const { ui } = useServices();
  const state = useStore(ui);
  useEditorState();
  usePageHistory();
  return (
    <div className="ribbon">
      <div className="ribbon-tabs" role="tablist" aria-label="Ribbon">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            id={`ribbon-tab-${t.id}`}
            aria-selected={state.ribbonTab === t.id}
            className={`ribbon-tab ${state.ribbonTab === t.id ? 'is-selected' : ''}`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => patchUi(ui, { ribbonTab: t.id })}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="ribbon-card" role="tabpanel" aria-labelledby={`ribbon-tab-${state.ribbonTab}`}>
        {state.ribbonTab === 'home' && <HomeTab />}
        {state.ribbonTab === 'insert' && <InsertTab />}
        {state.ribbonTab === 'draw' && <DrawTab />}
        {state.ribbonTab === 'view' && <ViewTab />}
      </div>
    </div>
  );
}
