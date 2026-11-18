/**
 * The board two ways. `BoardScreen` is the board view, in place of the pages
 * pane and canvas: the bar, the board, and the page open beside it.
 * `BoardBeside` is the board as a pane beside the page in the notebook view;
 * a card opened from it becomes the page shown. Both tint the backdrop with
 * the notebook's colour and take the board's keyboard shortcuts. The filter,
 * the open composer and the open page belong to one board, so another
 * notebook's board starts without them.
 */
import { useEffect, useRef, type CSSProperties } from 'react';
import { colorHex, getNotebook } from '@looseleaf/model';
import { useServices } from '../app/services.js';
import { useStore } from '../app/store.js';
import { patchUi } from '../app/ui-state.js';
import { useYValue } from '../app/yjs-hooks.js';
import { BoardBar } from './BoardBar.js';
import { useBoardShortcuts } from './board-shortcuts.js';
import { BoardView } from './BoardView.js';
import { CardPane } from './CardPane.js';
import type { CurrentBoard } from './live-board.js';

/** The notebook's colour as the board's `--board`, and a reset of the board's filter and composer when the notebook changes. */
function useBoardFrame(current: CurrentBoard): CSSProperties | undefined {
  const { ui, library } = useServices();
  const notebookId = current.notebookId;
  const color = useYValue(library, () => getNotebook(library, notebookId)?.color ?? null, notebookId);
  const first = useRef(notebookId);
  useEffect(() => {
    if (first.current === notebookId) return;
    first.current = notebookId;
    patchUi(ui, { boardLabels: [], boardQuery: '', composer: null, boardPage: null });
  }, [notebookId, ui]);
  useBoardShortcuts(current);
  return color ? { ['--board' as string]: colorHex(color) } : undefined;
}

export function BoardScreen({ current }: { current: CurrentBoard }) {
  const { ui } = useServices();
  const boardPage = useStore(ui).boardPage;
  const style = useBoardFrame(current);
  return (
    <div className={`board-screen ${boardPage ? 'has-card' : ''}`} style={style}>
      <div className="board-main">
        <BoardBar current={current} />
        <BoardView current={current} />
      </div>
      {boardPage && <CardPane current={current} pageId={boardPage} />}
    </div>
  );
}

export function BoardBeside({ current }: { current: CurrentBoard }) {
  const { ui } = useServices();
  const width = useStore(ui).paneWidths.board;
  const style = useBoardFrame(current);
  return (
    <aside className="board-screen board-beside" style={{ ...style, width: width > 0 ? width : '50%' }} aria-label="Board">
      <div className="board-main">
        <BoardBar current={current} onClose={() => patchUi(ui, { boardBeside: false })} />
        <BoardView current={current} />
      </div>
    </aside>
  );
}
