/**
 * One open page: the title (which edits the page node's name), the card strip
 * when the page is a card, the created date and time, and the freeform
 * canvas, zoomed as a whole while the chrome stays put. A card's page has the
 * Activity panel beside it. In the notebook view of a notebook with a board,
 * the strip's place holds a "Board" toggle that shows the board beside the
 * page. It owns the page's session (doc + undo history) for as long as the
 * page is open and keeps the page's search text, To Do lines and Inbox pills
 * fresh.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { BoardRegular } from '@fluentui/react-icons';
import type * as Y from 'yjs';
import { getNode, pageDocId, readPageMeta, renameNode, PAPER_SPACING } from '@looseleaf/model';
import { useServices } from '../app/services.js';
import { useStore } from '../app/store.js';
import { patchUi } from '../app/ui-state.js';
import { useOpenDoc, useYValue } from '../app/yjs-hooks.js';
import { ActivityPanel, activityStartsOpen } from '../board/ActivityPanel.js';
import { CardStrip } from '../board/CardStrip.js';
import { liveCard, useCurrentBoard } from '../board/live-board.js';
import { followPageInbox } from '../board/page-inbox.js';
import { followPageText } from '../search/follow-page-text.js';
import { Canvas, TITLE_BLOCK_HEIGHT } from './Canvas.js';
import { placeFiles } from './insert.js';
import { PageSession } from './page-session.js';

export function PageView({ notebookId, pageId, notebookDoc }: { notebookId: string; pageId: string; notebookDoc: Y.Doc }) {
  const services = useServices();
  const { client, page, search, todoLines, ui } = services;
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

  useEffect(
    () => (doc ? followPageText(doc, notebookDoc, { notebookId, pageId }, { search, lines: todoLines }) : undefined),
    [doc, notebookDoc, notebookId, pageId, search, todoLines],
  );

  useEffect(() => (session ? followPageInbox(session, services.boards, todoLines) : undefined), [session, services.boards, todoLines]);

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
  const board = useCurrentBoard();
  const card = board && board.notebookId === notebookId ? liveCard(board.board, pageId) : null;
  const [activityChoice, setActivityChoice] = useState<boolean | null>(null);
  const [titleHeight, setTitleHeight] = useState(TITLE_BLOCK_HEIGHT);
  const activityOpen = card !== null && (activityChoice ?? activityStartsOpen(card));

  if (!node || node.kind !== 'page') return null;
  const spacing = meta ? PAPER_SPACING[meta.paperStyle] : null;
  const paperClass = meta && meta.paperStyle !== 'none' ? `paper-${meta.paperStyle.startsWith('grid') ? 'grid' : 'ruled'}` : '';

  const besideToggle =
    board && board.notebookId === notebookId && state.view === 'page' ? (
      <button
        type="button"
        className={`strip-button board-beside-toggle ${state.boardBeside ? 'is-active' : ''}`}
        aria-pressed={state.boardBeside}
        title="Board beside page"
        onClick={() => patchUi(ui, { boardBeside: !state.boardBeside })}
      >
        <BoardRegular aria-hidden="true" />
        Board
      </button>
    ) : null;
  const strip =
    board && card ? (
      <CardStrip current={board} card={card} activityOpen={activityOpen} onToggleActivity={() => setActivityChoice(!activityOpen)}>
        {besideToggle}
      </CardStrip>
    ) : besideToggle ? (
      <div className="loose-strip">{besideToggle}</div>
    ) : null;

  return (
    <div className="page-frame">
      <div className="page-view" ref={scroller} data-testid="page-view">
        <div
          className={`page-paper ${paperClass} ${meta?.paperColor ? 'has-paper-color' : ''}`}
          style={{
            ['--paper-spacing' as string]: spacing ? `${spacing}px` : undefined,
            ['--paper-color' as string]: meta?.paperColor ?? undefined,
          }}
        >
          {session ? (
            <Canvas
              session={session}
              scroller={scroller}
              zoom={state.zoom}
              titleHeight={titleHeight}
              titleBlock={<TitleBlock notebookDoc={notebookDoc} pageId={pageId} strip={strip} onHeight={setTitleHeight} />}
            />
          ) : (
            <div className="page-loading" aria-busy="true" />
          )}
        </div>
      </div>
      {board && card && activityOpen && <ActivityPanel current={board} card={card} onClose={() => setActivityChoice(false)} />}
    </div>
  );
}

/** The title, the card strip when there is one, and the created date. It reports its height in canvas px, which grows when the strip wraps. */
function TitleBlock({ notebookDoc, pageId, strip, onHeight }: { notebookDoc: Y.Doc; pageId: string; strip: ReactNode; onHeight: (height: number) => void }) {
  const { ui } = useServices();
  const focusTitle = useStore(ui).focusTitle;
  const node = useYValue(notebookDoc, () => getNode(notebookDoc, pageId), pageId);
  const input = useRef<HTMLInputElement>(null);
  const firstFocus = useRef(focusTitle);
  useEffect(() => {
    if (focusTitle !== firstFocus.current) input.current?.focus();
  }, [focusTitle]);
  const block = useRef<HTMLDivElement>(null);
  const shown = node !== null;
  useLayoutEffect(() => {
    const el = block.current;
    if (!el) return;
    // offsetHeight ignores the zoom's transform, so this is in canvas px.
    const report = () => onHeight(Math.max(TITLE_BLOCK_HEIGHT, el.offsetHeight));
    report();
    const observer = new ResizeObserver(report);
    observer.observe(el);
    return () => observer.disconnect();
  }, [onHeight, shown]);
  if (!node) return null;
  const created = new Date(node.createdAt);
  return (
    <div ref={block} className="title-block" style={{ minHeight: TITLE_BLOCK_HEIGHT }} onClick={(e) => e.stopPropagation()}>
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
      {strip}
      <div className="page-date">
        {created.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
        <span className="page-time">{created.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</span>
      </div>
    </div>
  );
}
