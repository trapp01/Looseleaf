/**
 * The menu of a To Do line that is in the Inbox, the same wherever it opens
 * (the line's menu button in the Inbox lane, the "Inbox" pill on the page,
 * right-click or a long press on the line): "Make it a card in" with the
 * board's statuses, then "Keep it as a line".
 */
import { CheckboxUncheckedRegular } from '@fluentui/react-icons';
import type { BoardSnapshot } from '@looseleaf/model';
import type { Services } from '../app/services.js';
import { showMenu, type MenuEntry } from '../nav/context-menu.js';
import { KindMarker } from './KindMarker.js';
import { keepLine, makeCard, type LineRef } from './line-actions.js';

export function lineMenuEntries(services: Services, board: BoardSnapshot, line: LineRef): MenuEntry[] {
  return [
    { heading: 'Make it a card in' },
    ...board.statuses.map((status) => ({
      label: status.name,
      icon: (
        <span className="menu-kind" aria-hidden="true">
          <KindMarker kind={status.kind} />
        </span>
      ),
      onSelect: () => void makeCard(services, line, status.id),
    })),
    'separator',
    { label: 'Keep it as a line', icon: <CheckboxUncheckedRegular />, onSelect: () => void keepLine(services, line) },
  ];
}

export function showLineMenu(services: Services, board: BoardSnapshot, line: LineRef, x: number, y: number): void {
  showMenu(x, y, lineMenuEntries(services, board, line));
}
