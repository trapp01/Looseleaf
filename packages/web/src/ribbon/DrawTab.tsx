/** The Draw tab: text mode, pen, marker, highlighter, eraser, four colours and a picker, five widths. */
import {
  ArrowBetweenDownRegular,
  EraserRegular,
  HighlightRegular,
  InkingToolRegular,
  LassoRegular,
  PenRegular,
  TextTRegular,
} from '@fluentui/react-icons';
import type { ReactNode } from 'react';
import { useServices } from '../app/services.js';
import { useStore } from '../app/store.js';
import { patchUi, type DrawTool } from '../app/ui-state.js';
import { Group, Row, Rows, Unavailable } from './parts.js';

export const INK_COLORS = ['#1f1f1f', '#d1495b', '#3b7dd8', '#4f9d4a'];
export const HIGHLIGHTER_COLORS = ['#ffe14d', '#7ee081', '#6fd3f2', '#ff9ecf'];
export const INK_WIDTHS = [1, 2, 4, 6, 10];

const TOOLS: Array<{ tool: DrawTool; label: string; icon: ReactNode }> = [
  { tool: 'pen', label: 'Pen', icon: <PenRegular /> },
  { tool: 'marker', label: 'Marker', icon: <InkingToolRegular /> },
  { tool: 'highlighter', label: 'Highlighter', icon: <HighlightRegular /> },
];

export function DrawTab() {
  const { ui, commands } = useServices();
  const { tool, inkColor, inkWidth } = useStore(ui);
  const hasPage = commands.isEnabled('zoom-in');
  const colors = tool === 'highlighter' ? HIGHLIGHTER_COLORS : INK_COLORS;
  const pick = (next: DrawTool) => {
    const patch: Parameters<typeof patchUi>[1] = { tool: next };
    if (next === 'highlighter' && !HIGHLIGHTER_COLORS.includes(inkColor)) patch.inkColor = HIGHLIGHTER_COLORS[0];
    if ((next === 'pen' || next === 'marker') && HIGHLIGHTER_COLORS.includes(inkColor)) patch.inkColor = INK_COLORS[0];
    patchUi(ui, patch);
  };
  const toolButton = (t: DrawTool, label: string, icon: ReactNode, large = false) => (
    <button
      key={t}
      type="button"
      className={`ribbon-button ${large ? 'is-large' : 'has-label'} ${tool === t ? 'is-active' : ''}`}
      aria-pressed={tool === t}
      aria-label={label}
      title={label}
      disabled={!hasPage}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => pick(t)}
    >
      <span className="ribbon-icon">{icon}</span>
      <span className="ribbon-label">{label}</span>
    </button>
  );
  return (
    <div className="ribbon-groups">
      <Group label="Tools">
        {toolButton('text', 'Text mode', <TextTRegular />, true)}
        <Unavailable icon={<LassoRegular />} label="Lasso select" large />
        <Unavailable icon={<ArrowBetweenDownRegular />} label="Insert space" large />
        {toolButton('eraser', 'Eraser', <EraserRegular />, true)}
      </Group>
      <Group label="Pens">{TOOLS.map((t) => toolButton(t.tool, t.label, t.icon, true))}</Group>
      <Group label="Colour">
        <Rows>
          <Row>
            {colors.map((c) => (
              <button
                key={c}
                type="button"
                className={`swatch ink-swatch ${c === inkColor ? 'is-selected' : ''}`}
                style={{ background: c }}
                aria-label={`Ink colour ${c}`}
                aria-pressed={c === inkColor}
                disabled={!hasPage}
                onClick={() => patchUi(ui, { inkColor: c, tool: tool === 'text' || tool === 'eraser' ? 'pen' : tool })}
              />
            ))}
            <label className={`swatch ink-swatch color-custom ${colors.includes(inkColor) ? '' : 'is-selected'}`} title="More colours" style={{ background: colors.includes(inkColor) ? undefined : inkColor }}>
              <input type="color" aria-label="More ink colours" value={inkColor} disabled={!hasPage} onChange={(e) => patchUi(ui, { inkColor: e.target.value })} />
            </label>
          </Row>
          <Row>
            {INK_WIDTHS.map((w) => (
              <button
                key={w}
                type="button"
                className={`width-option ${w === inkWidth ? 'is-selected' : ''}`}
                aria-label={`Width ${w}`}
                aria-pressed={w === inkWidth}
                disabled={!hasPage}
                onClick={() => patchUi(ui, { inkWidth: w })}
              >
                <span style={{ width: Math.max(2, w * 1.6), height: Math.max(2, w * 1.6) }} />
              </button>
            ))}
          </Row>
        </Rows>
      </Group>
    </div>
  );
}
