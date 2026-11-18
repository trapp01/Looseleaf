/** Renders whichever dialog the UI state names; there is at most one. */
import { useCallback, useState, type FormEvent } from 'react';
import { COLORS, createNotebook, createPage, createSection, type ColorName } from '@looseleaf/model';
import { Dialog } from './controls.js';
import { useServices } from './services.js';
import { useStore } from './store.js';
import { patchUi } from './ui-state.js';
import { Settings } from './Settings.js';
import { ExportDialog } from '../exporting/ExportDialog.js';
import { ImportDialog } from '../importing/ImportDialog.js';
import { MovePicker } from '../nav/MovePicker.js';
import { PhoneFormatSheet } from '../phone/FormatBar.js';
import { ArchiveDialog } from '../board/ArchiveDialog.js';
import { ShortcutsDialog } from '../board/board-shortcuts.js';
import { LabelsDialog } from '../board/LabelsDialog.js';
import { useCurrentBoard } from '../board/live-board.js';
import { NewBoardDialog } from '../board/NewBoardDialog.js';

export function Dialogs() {
  const { ui } = useServices();
  const dialog = useStore(ui).dialog;
  const board = useCurrentBoard();
  const close = useCallback(() => patchUi(ui, { dialog: null }), [ui]);
  if (!dialog) return null;
  switch (dialog.kind) {
    case 'settings':
    case 'sync':
      return <Settings onClose={close} />;
    case 'export':
      return <ExportDialog request={dialog} onClose={close} />;
    case 'import':
      return <ImportDialog onClose={close} />;
    case 'link':
      return <LinkDialog href={dialog.href} onClose={close} />;
    case 'new-notebook':
      return <NewNotebookDialog onClose={close} />;
    case 'move':
      return <MovePicker notebookId={dialog.notebookId} nodeId={dialog.nodeId} onClose={close} />;
    case 'phone-format':
      return <PhoneFormatSheet onClose={close} />;
    case 'new-board':
      return <NewBoardDialog notebookId={dialog.notebookId} onClose={close} />;
    case 'board-labels':
      return board ? <LabelsDialog current={board} onClose={close} /> : null;
    case 'board-archive':
      return board ? <ArchiveDialog current={board} onClose={close} /> : null;
    case 'board-shortcuts':
      return <ShortcutsDialog onClose={close} />;
  }
}

function LinkDialog({ href, onClose }: { href: string; onClose: () => void }) {
  const { commands } = useServices();
  const [value, setValue] = useState(href);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = value.trim();
    const withScheme = trimmed && !/^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? `https://${trimmed}` : trimmed;
    onClose();
    commands.run('link', withScheme);
  };
  return (
    <Dialog title={href ? 'Edit link' : 'Insert link'} onClose={onClose}>
      <form onSubmit={submit} className="stack">
        <label className="field">
          <span>Address</span>
          <input value={value} onChange={(e) => setValue(e.target.value)} placeholder="https://example.com" autoFocus spellCheck={false} />
        </label>
        <div className="form-actions">
          {href && (
            <button
              type="button"
              className="button"
              onClick={() => {
                onClose();
                commands.run('link', '');
              }}
            >
              Remove link
            </button>
          )}
          <button type="submit" className="button primary" disabled={!value.trim()}>
            {href ? 'Save' : 'Insert'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function NewNotebookDialog({ onClose }: { onClose: () => void }) {
  const { library, notebooks, selection, ui } = useServices();
  const [name, setName] = useState('');
  const [color, setColor] = useState<ColorName>(COLORS[0].name);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const id = createNotebook(library, { name: name.trim() || 'My Notebook', color });
    const doc = await notebooks.load(id);
    const section = createSection(doc, { name: 'New Section 1', parent: null });
    const page = createPage(doc, { section, title: '' });
    selection.set({ notebookId: id, sectionId: section, pageId: page });
    patchUi(ui, { dialog: null, view: 'page', railPanel: 'notebooks', phonePane: 'pages' });
  };
  return (
    <Dialog title="New notebook" onClose={onClose}>
      <form onSubmit={submit} className="stack">
        <label className="field">
          <span>Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="My Notebook" autoFocus />
        </label>
        <fieldset className="field">
          <legend>Colour</legend>
          <div className="swatches">
            {COLORS.map((c) => (
              <button
                type="button"
                key={c.name}
                className={`swatch ${c.name === color ? 'is-selected' : ''}`}
                style={{ background: c.hex }}
                aria-label={c.name}
                aria-pressed={c.name === color}
                onClick={() => setColor(c.name)}
              />
            ))}
          </div>
        </fieldset>
        <div className="form-actions">
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button primary">
            Create notebook
          </button>
        </div>
      </form>
    </Dialog>
  );
}
