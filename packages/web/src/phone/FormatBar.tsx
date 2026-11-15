/**
 * The phone's formatting bar, docked above the on-screen keyboard with the
 * most used Home commands, and the sheet with the rest. Both run through the
 * command table like the ribbon.
 */
import {
  ArrowUndoRegular,
  CheckboxCheckedRegular,
  ImageRegular,
  MoreHorizontalRegular,
  TextBoldRegular,
  TextBulletListLtrRegular,
  TextIndentDecreaseLtrRegular,
  TextIndentIncreaseLtrRegular,
  TextItalicRegular,
  TextNumberListLtrRegular,
  TextUnderlineRegular,
} from '@fluentui/react-icons';
import type { ReactNode } from 'react';
import { Dialog } from '../app/controls.js';
import { useServices } from '../app/services.js';
import { patchUi } from '../app/ui-state.js';
import type { CommandId } from '../commands/command-table.js';
import { usePageHistory } from '../canvas/use-page.js';
import { useEditorState } from '../ribbon/Ribbon.js';
import { STYLE_COMMANDS, TAG_COMMANDS } from '../ribbon/HomeTab.js';
import { FONT_COLORS, HIGHLIGHT_COLORS } from '../ribbon/parts.js';

const BAR: Array<{ id: CommandId; icon: ReactNode }> = [
  { id: 'bold', icon: <TextBoldRegular /> },
  { id: 'italic', icon: <TextItalicRegular /> },
  { id: 'underline', icon: <TextUnderlineRegular /> },
  { id: 'bullet-list', icon: <TextBulletListLtrRegular /> },
  { id: 'ordered-list', icon: <TextNumberListLtrRegular /> },
  { id: 'tag-todo', icon: <CheckboxCheckedRegular /> },
  { id: 'outdent', icon: <TextIndentDecreaseLtrRegular /> },
  { id: 'indent', icon: <TextIndentIncreaseLtrRegular /> },
  { id: 'insert-picture', icon: <ImageRegular /> },
  { id: 'undo', icon: <ArrowUndoRegular /> },
];

export function FormatBar() {
  const { commands, ui } = useServices();
  useEditorState();
  usePageHistory();
  return (
    <div className="format-bar" role="toolbar" aria-label="Formatting">
      {BAR.map((b) => (
        <button
          key={b.id}
          className={`format-button ${commands.isActive(b.id) ? 'is-active' : ''}`}
          aria-label={commands.get(b.id).label}
          aria-pressed={commands.get(b.id).active ? commands.isActive(b.id) : undefined}
          disabled={!commands.isEnabled(b.id)}
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => commands.run(b.id)}
        >
          {b.icon}
        </button>
      ))}
      <button className="format-button" aria-label="More formatting" onPointerDown={(e) => e.preventDefault()} onClick={() => patchUi(ui, { dialog: { kind: 'phone-format' } })}>
        <MoreHorizontalRegular />
      </button>
    </div>
  );
}

export function PhoneFormatSheet({ onClose }: { onClose: () => void }) {
  const { commands } = useServices();
  useEditorState();
  const run = (id: CommandId, arg?: unknown) => {
    onClose();
    setTimeout(() => commands.run(id, arg), 0);
  };
  const chip = (id: CommandId, label = commands.get(id).label, arg?: unknown) => (
    <button key={`${id}-${String(arg)}`} className={`sheet-chip ${commands.isActive(id, arg) ? 'is-selected' : ''}`} disabled={!commands.isEnabled(id, arg)} onClick={() => run(id, arg)}>
      {label}
    </button>
  );
  return (
    <Dialog title="Formatting" onClose={onClose} className="is-sheet">
      <h3 className="sheet-heading">Text</h3>
      <div className="sheet-chips">
        {chip('strike')}
        {chip('subscript')}
        {chip('superscript')}
        {chip('clear-formatting')}
        {chip('link')}
      </div>
      <h3 className="sheet-heading">Highlight</h3>
      <div className="swatches">
        {HIGHLIGHT_COLORS.map((c) => (
          <button key={c} className="swatch" style={{ background: c }} aria-label={`Highlight ${c}`} onClick={() => run('highlight', c)} />
        ))}
        <button className="sheet-chip" onClick={() => run('highlight', null)}>None</button>
      </div>
      <h3 className="sheet-heading">Font colour</h3>
      <div className="swatches">
        {FONT_COLORS.map((c) => (
          <button key={c} className="swatch" style={{ background: c }} aria-label={`Font colour ${c}`} onClick={() => run('font-color', c)} />
        ))}
        <button className="sheet-chip" onClick={() => run('font-color', null)}>Automatic</button>
      </div>
      <h3 className="sheet-heading">Paragraph</h3>
      <div className="sheet-chips">
        {chip('align', 'Left', 'left')}
        {chip('align', 'Centre', 'center')}
        {chip('align', 'Right', 'right')}
      </div>
      <h3 className="sheet-heading">Styles</h3>
      <div className="sheet-chips">{STYLE_COMMANDS.map((s) => chip(s.id, s.label))}</div>
      <h3 className="sheet-heading">Tags</h3>
      <div className="sheet-chips">{TAG_COMMANDS.map((t) => chip(t.id))}</div>
      <h3 className="sheet-heading">Insert</h3>
      <div className="sheet-chips">
        {chip('insert-table', 'Table', { rows: 3, cols: 3 })}
        {chip('insert-file', 'File')}
        {chip('insert-date')}
        {chip('insert-date-time')}
      </div>
    </Dialog>
  );
}
