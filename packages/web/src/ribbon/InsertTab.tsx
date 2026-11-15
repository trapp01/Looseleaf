/** The Insert tab: table (with a size grid, and row and column commands while the caret is in a table), file, picture, link, date. */
import { useState } from 'react';
import {
  AttachRegular,
  CalendarLtrRegular,
  CalendarPersonRegular,
  ClockRegular,
  DocumentPrintRegular,
  ImageRegular,
  LinkRegular,
  MathFormulaRegular,
  MicRegular,
  ScreenshotRegular,
  ShapesRegular,
  StickerRegular,
  TableCellsMergeRegular,
  TableCellsSplitRegular,
  TableDeleteColumnRegular,
  TableDeleteRowRegular,
  TableDismissRegular,
  TableInsertColumnRegular,
  TableInsertRowRegular,
  TableRegular,
} from '@fluentui/react-icons';
import { useServices } from '../app/services.js';
import { useEditorState } from './Ribbon.js';
import { Cmd, Group, MenuButton, Row, Rows, Unavailable } from './parts.js';

const GRID = 8;

export function InsertTab() {
  const { commands } = useServices();
  const editor = useEditorState();
  const inTable = !!editor?.isActive('table');
  return (
    <div className="ribbon-groups">
      <Group label="Table">
        <MenuButton icon={<TableRegular />} label="Table" large disabled={!commands.isEnabled('insert-table')} testId="insert-table">
          {(close) => <TableGrid onPick={(rows, cols) => (close(), commands.run('insert-table', { rows, cols }))} />}
        </MenuButton>
      </Group>
      {inTable && (
        <Group label="Table tools" className="is-contextual">
          <Rows>
            <Row>
              <Cmd id="table-row-above" icon={<TableInsertRowRegular />} showLabel />
              <Cmd id="table-row-below" icon={<TableInsertRowRegular />} showLabel />
              <Cmd id="table-delete-row" icon={<TableDeleteRowRegular />} showLabel />
              <Cmd id="table-merge" icon={<TableCellsMergeRegular />} showLabel />
            </Row>
            <Row>
              <Cmd id="table-column-left" icon={<TableInsertColumnRegular />} showLabel />
              <Cmd id="table-column-right" icon={<TableInsertColumnRegular />} showLabel />
              <Cmd id="table-delete-column" icon={<TableDeleteColumnRegular />} showLabel />
              <Cmd id="table-split" icon={<TableCellsSplitRegular />} showLabel />
            </Row>
          </Rows>
          <Cmd id="table-delete" icon={<TableDismissRegular />} large />
        </Group>
      )}
      <Group label="Files">
        <Cmd id="insert-file" icon={<AttachRegular />} large label="File" />
        <Unavailable icon={<DocumentPrintRegular />} label="Printout" large />
      </Group>
      <Group label="Pictures">
        <Cmd id="insert-picture" icon={<ImageRegular />} large label="Picture" />
        <Unavailable icon={<ScreenshotRegular />} label="Screenshot" large />
      </Group>
      <Group label="Links">
        <Cmd id="link" icon={<LinkRegular />} large />
      </Group>
      <Group label="Symbols">
        <Unavailable icon={<MathFormulaRegular />} label="Equation" large />
      </Group>
      <Group label="Time stamp">
        <Rows>
          <Row>
            <Cmd id="insert-date" icon={<CalendarLtrRegular />} showLabel />
          </Row>
          <Row>
            <Cmd id="insert-date-time" icon={<ClockRegular />} showLabel />
          </Row>
        </Rows>
      </Group>
      <Group label="More">
        <Unavailable icon={<ShapesRegular />} label="Shapes" large />
        <Unavailable icon={<MicRegular />} label="Audio" large />
        <Unavailable icon={<CalendarPersonRegular />} label="Meeting details" large />
        <Unavailable icon={<StickerRegular />} label="Stickers" large />
      </Group>
    </div>
  );
}

function TableGrid({ onPick }: { onPick: (rows: number, cols: number) => void }) {
  const [hover, setHover] = useState({ rows: 0, cols: 0 });
  return (
    <div className="table-grid">
      <div className="table-grid-cells" onMouseLeave={() => setHover({ rows: 0, cols: 0 })} role="grid" aria-label="Table size">
        {Array.from({ length: GRID * GRID }, (_, i) => {
          const r = Math.floor(i / GRID) + 1;
          const c = (i % GRID) + 1;
          const on = r <= hover.rows && c <= hover.cols;
          return (
            <button
              key={i}
              type="button"
              className={`table-grid-cell ${on ? 'is-on' : ''}`}
              aria-label={`${r} by ${c}`}
              data-testid={`table-${r}x${c}`}
              onMouseEnter={() => setHover({ rows: r, cols: c })}
              onFocus={() => setHover({ rows: r, cols: c })}
              onClick={() => onPick(r, c)}
            />
          );
        })}
      </div>
      <div className="table-grid-label">{hover.rows ? `${hover.cols} × ${hover.rows} table` : 'Insert table'}</div>
    </div>
  );
}
