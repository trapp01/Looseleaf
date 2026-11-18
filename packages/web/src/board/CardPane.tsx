/**
 * A page open beside the board: a card's page, or the page an Inbox line is
 * on. It is the real page (canvas, and for a card the strip and Activity
 * panel) with a bar above it. "Open full page" switches to the notebook view
 * at the page; the close button and Escape give the board its full width
 * back. The pane closes itself when the page leaves the notebook, and when a
 * card's page stops being a card here.
 */
import { useEffect, useRef } from 'react';
import { DismissRegular, OpenRegular } from '@fluentui/react-icons';
import { getNode, livePages } from '@looseleaf/model';
import { IconButton } from '../app/controls.js';
import { useServices } from '../app/services.js';
import { patchUi } from '../app/ui-state.js';
import { useYValue } from '../app/yjs-hooks.js';
import { PageView } from '../canvas/PageView.js';
import { isTyping, layerOpen } from './board-shortcuts.js';
import { liveCard, type CurrentBoard } from './live-board.js';

export function CardPane({ current, pageId }: { current: CurrentBoard; pageId: string }) {
  const { ui, selection } = useServices();
  const card = liveCard(current.board, pageId);
  const live = useYValue(current.notebookDoc, () => livePages(current.notebookDoc).has(pageId), pageId);
  const sectionId = useYValue(current.notebookDoc, () => getNode(current.notebookDoc, pageId)?.parent ?? null, pageId);
  const wasCard = useRef({ pageId, card: card !== null });
  const close = () => patchUi(ui, { boardPage: null });

  useEffect(() => {
    const archived = wasCard.current.pageId === pageId && wasCard.current.card && card === null;
    wasCard.current = { pageId, card: card !== null };
    if (!live || archived) patchUi(ui, { boardPage: null });
  }, [card, live, pageId, ui]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || isTyping(event.target) || layerOpen()) return;
      event.preventDefault();
      patchUi(ui, { boardPage: null });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ui]);

  if (!live) return null;
  const openFull = () => {
    selection.selectPage(pageId, sectionId ?? undefined, current.notebookId);
    patchUi(ui, { view: 'page', boardPage: null, phonePane: 'page' });
  };
  return (
    <section className="card-pane" aria-label={card ? 'Card page' : 'Page'}>
      <div className="card-pane-bar">
        <button type="button" className="button small" onClick={openFull}>
          <OpenRegular aria-hidden="true" />
          Open full page
        </button>
        <span className="spacer" />
        <IconButton label={card ? 'Close card' : 'Close page'} onClick={close}>
          <DismissRegular />
        </IconButton>
      </div>
      <PageView key={pageId} notebookId={current.notebookId} pageId={pageId} notebookDoc={current.notebookDoc} />
    </section>
  );
}
