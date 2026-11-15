/**
 * One open page: the title (which edits the page node's name), the created
 * date and time, and the freeform canvas, zoomed as a whole while the chrome
 * stays put. It owns the page's session (doc + undo history) for as long as
 * the page is open and keeps the page's search text fresh.
 */
import { useEffect, useRef, useState } from 'react';
import type * as Y from 'yjs';
import { getNode, pageDocId, readPageMeta, renameNode, PAPER_SPACING } from '@looseleaf/model';
import { useServices } from '../app/services.js';
import { useStore } from '../app/store.js';
import { useOpenDoc, useYValue } from '../app/yjs-hooks.js';
import { followPageText } from '../search/follow-page-text.js';
import { Canvas, TITLE_BLOCK_HEIGHT } from './Canvas.js';
import { placeFiles } from './insert.js';
import { PageSession } from './page-session.js';

export function PageView({ notebookId, pageId, notebookDoc }: { notebookId: string; pageId: string; notebookDoc: Y.Doc }) {
  const services = useServices();
  const { client, page, search, ui } = services;
  const doc = useOpenDoc(client, pageDocId(pageId));
  const [session, setSession] = useState<PageSession | null>(null);

  useEffect(() => {
    client.setPriorityDoc(pageDocId(pageId));
    return () => client.setPriorityDoc(null);
  }, [client, pageId]);

  useEffect(() => {
    if (!doc) return;
    const s = new PageSession(notebookId, pageId, doc, notebookDoc);
    setSession(s);
    page.set(s);
    return () => {
      if (page.get() === s) page.set(null);
      services.activeEditor.set(null);
      s.destroy();
    };
  }, [doc, notebookId, pageId, notebookDoc, page, services.activeEditor]);

  useEffect(() => (doc ? followPageText(doc, notebookDoc, pageId, search) : undefined), [doc, notebookDoc, pageId, search]);

  // Files pasted while no text is being edited land on the page under its content.
  useEffect(() => {
    if (!session) return;
    const onPaste = (event: ClipboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest?.('.ProseMirror, input, textarea, [contenteditable="true"]')) return;
      const files = [...(event.clipboardData?.files ?? [])];
      if (files.length === 0) return;
      event.preventDefault();
      void placeFiles(services, session, files, {});
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [services, session]);

  const state = useStore(ui);
  const meta = useYValue(doc?.getMap('meta') ?? null, () => (doc ? readPageMeta(doc) : null), doc);
  const node = useYValue(notebookDoc, () => getNode(notebookDoc, pageId), pageId);
  const scroller = useRef<HTMLDivElement>(null);

  if (!node || node.kind !== 'page') return null;
  const spacing = meta ? PAPER_SPACING[meta.paperStyle] : null;
  const paperClass = meta && meta.paperStyle !== 'none' ? `paper-${meta.paperStyle.startsWith('grid') ? 'grid' : 'ruled'}` : '';

  return (
    <div className="page-view" ref={scroller} data-testid="page-view">
      <div
        className={`page-paper ${paperClass} ${meta?.paperColor ? 'has-paper-color' : ''}`}
        style={{
          ['--paper-spacing' as string]: spacing ? `${spacing}px` : undefined,
          ['--paper-color' as string]: meta?.paperColor ?? undefined,
        }}
      >
        {session ? (
          <Canvas session={session} scroller={scroller} zoom={state.zoom} titleBlock={<TitleBlock notebookDoc={notebookDoc} pageId={pageId} />} />
        ) : (
          <div className="page-loading" aria-busy="true" />
        )}
      </div>
    </div>
  );
}

function TitleBlock({ notebookDoc, pageId }: { notebookDoc: Y.Doc; pageId: string }) {
  const { ui } = useServices();
  const focusTitle = useStore(ui).focusTitle;
  const node = useYValue(notebookDoc, () => getNode(notebookDoc, pageId), pageId);
  const input = useRef<HTMLInputElement>(null);
  const firstFocus = useRef(focusTitle);
  useEffect(() => {
    if (focusTitle !== firstFocus.current) input.current?.focus();
  }, [focusTitle]);
  if (!node) return null;
  const created = new Date(node.createdAt);
  return (
    <div className="title-block" style={{ height: TITLE_BLOCK_HEIGHT }} onClick={(e) => e.stopPropagation()}>
      <input
        ref={input}
        className="page-title"
        value={node.name}
        placeholder="Untitled page"
        aria-label="Page title"
        onChange={(e) => renameNode(notebookDoc, pageId, e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }}
      />
      <div className="page-date">
        {created.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
        <span className="page-time">{created.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</span>
      </div>
    </div>
  );
}
