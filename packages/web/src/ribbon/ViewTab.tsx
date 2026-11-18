/** The View tab: zoom, paper colour and style, the board beside the page, Deleted notes; the rest shows disabled in OneNote's places. */
import {
  AccessibilityCheckmarkRegular,
  BoardRegular,
  ClosedCaptionRegular,
  DarkThemeRegular,
  DeleteRegular,
  EyeOffRegular,
  GridRegular,
  ImmersiveReaderRegular,
  PaintBucketRegular,
  PeopleRegular,
  TranslateRegular,
  WindowNewRegular,
  ZoomFitRegular,
  ZoomInRegular,
  ZoomOutRegular,
} from '@fluentui/react-icons';
import { PAPER_STYLES, readPageMeta, setPaperColor, setPaperStyle, type PaperStyle } from '@looseleaf/model';
import { useServices } from '../app/services.js';
import { useStore } from '../app/store.js';
import { patchUi, ZOOM_STEPS } from '../app/ui-state.js';
import { useCurrentBoard } from '../board/live-board.js';
import { usePageHistory } from '../canvas/use-page.js';
import { useYValue } from '../app/yjs-hooks.js';
import { Cmd, ColorGrid, Group, MenuButton, Row, Rows, Unavailable } from './parts.js';

export const PAPER_STYLE_LABELS: Record<PaperStyle, string> = {
  none: 'None',
  'ruled-narrow': 'Narrow ruled',
  'ruled-college': 'College ruled',
  'ruled-standard': 'Standard ruled',
  'ruled-wide': 'Wide ruled',
  'grid-small': 'Small grid',
  'grid-medium': 'Medium grid',
  'grid-large': 'Large grid',
  'grid-xlarge': 'Very large grid',
};

export const PAPER_COLORS = ['#fffdf5', '#fff4d6', '#fde2e4', '#e2f0d9', '#ddebf7', '#e8e0f3', '#eeeeee', '#fdebd3'];

export function ViewTab() {
  const { ui, commands } = useServices();
  const { zoom } = useStore(ui);
  const session = usePageHistory();
  const meta = useYValue(session?.doc ?? null, () => (session ? readPageMeta(session.doc) : null), session);
  const hasPage = !!session && commands.isEnabled('zoom-in');
  return (
    <div className="ribbon-groups">
      <Group label="Window">
        <Unavailable icon={<WindowNewRegular />} label="New window" large />
        <Unavailable icon={<DarkThemeRegular />} label="Switch background" large why="The canvas follows the system’s light or dark setting" />
        <Unavailable icon={<ImmersiveReaderRegular />} label="Immersive reader" large />
      </Group>
      <Group label="Zoom">
        <Rows>
          <Row>
            <Cmd id="zoom-out" icon={<ZoomOutRegular />} />
            <select
              className="ribbon-select zoom-select"
              aria-label="Zoom"
              disabled={!hasPage}
              value={ZOOM_STEPS.includes(zoom) ? zoom : 'custom'}
              onChange={(e) => patchUi(ui, { zoom: Number(e.target.value) })}
            >
              {!ZOOM_STEPS.includes(zoom) && <option value="custom">{Math.round(zoom * 100)}%</option>}
              {ZOOM_STEPS.map((z) => (
                <option key={z} value={z}>
                  {Math.round(z * 100)}%
                </option>
              ))}
            </select>
            <Cmd id="zoom-in" icon={<ZoomInRegular />} />
          </Row>
          <Row>
            <Cmd id="zoom-reset" icon={<span className="zoom-100">100%</span>} label="100%" />
            <Cmd id="zoom-page-width" icon={<ZoomFitRegular />} showLabel />
          </Row>
        </Rows>
      </Group>
      <Group label="Page setup">
        <MenuButton icon={<PaintBucketRegular />} label="Paper colour" large disabled={!hasPage}>
          {(close) => <ColorGrid colors={PAPER_COLORS} noneLabel="No colour" onPick={(c) => (close(), session && setPaperColor(session.doc, c))} />}
        </MenuButton>
        <MenuButton icon={<GridRegular />} label="Paper style" large disabled={!hasPage} testId="paper-style">
          {(close) => (
            <div className="menu-list">
              {PAPER_STYLES.map((style) => (
                <button
                  key={style}
                  className={`menu-item ${meta?.paperStyle === style ? 'is-selected' : ''}`}
                  role="menuitemradio"
                  aria-checked={meta?.paperStyle === style}
                  onClick={() => (close(), session && setPaperStyle(session.doc, style))}
                >
                  <span className={`paper-sample paper-sample-${style.split('-')[0]}`} />
                  {PAPER_STYLE_LABELS[style]}
                </button>
              ))}
            </div>
          )}
        </MenuButton>
        <Unavailable icon={<EyeOffRegular />} label="Hide page title" large />
      </Group>
      <BoardGroup />
      <Group label="Notes">
        <Cmd id="deleted-notes" icon={<DeleteRegular />} large />
        <Unavailable icon={<PeopleRegular />} label="Hide authors" large />
      </Group>
      <Group label="Tools">
        <Unavailable icon={<TranslateRegular />} label="Translate" large />
        <Unavailable icon={<AccessibilityCheckmarkRegular />} label="Check accessibility" large />
        <Unavailable icon={<ClosedCaptionRegular />} label="Live captions" large />
      </Group>
    </div>
  );
}

/** "Board beside page"; it re-renders as the board loads, so it enables once the notebook's board is known. */
function BoardGroup() {
  useCurrentBoard();
  return (
    <Group label="Board">
      <Cmd id="board-beside" icon={<BoardRegular />} large />
    </Group>
  );
}
