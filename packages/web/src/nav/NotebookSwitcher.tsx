/** The sections pane header: the notebook's glyph, name and a chevron that opens the notebook list and its actions. */
import { useRef, useState } from 'react';
import {
  AddRegular,
  ArrowDownloadRegular,
  ArrowImportRegular,
  CheckmarkRegular,
  ChevronDownRegular,
  DeleteRegular,
  NotebookFilled,
  RenameRegular,
} from '@fluentui/react-icons';
import { COLORS, colorHex, deleteNotebook, getNotebook, renameNotebook, setNotebookColor } from '@looseleaf/model';
import { Popover } from '../app/controls.js';
import { useServices } from '../app/services.js';
import { useStore } from '../app/store.js';
import { patchUi } from '../app/ui-state.js';
import { useYValue } from '../app/yjs-hooks.js';
import { useNotebooks } from './notebook-docs.js';
import { RenameInput } from './RenameInput.js';

export function NotebookSwitcher() {
  const { library, selection, ui, commands } = useServices();
  const sel = useStore(selection);
  const notebooks = useNotebooks(library);
  const current = useYValue(library, () => (sel.notebookId ? getNotebook(library, sel.notebookId) : null), sel.notebookId);
  const renaming = useStore(ui).renaming;
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const close = () => setOpen(false);

  if (current && renaming === current.id) {
    return (
      <div className="pane-header notebook-header">
        <NotebookFilled style={{ color: colorHex(current.color) }} />
        <RenameInput
          value={current.name}
          onDone={(name) => {
            if (name) renameNotebook(library, current.id, name);
            patchUi(ui, { renaming: null });
          }}
        />
      </div>
    );
  }

  return (
    <div className="pane-header notebook-header">
      <button ref={anchor} className="notebook-switcher" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="menu">
        <NotebookFilled style={{ color: current ? colorHex(current.color) : undefined }} />
        <span className="notebook-name">{current?.name || 'Untitled notebook'}</span>
        <ChevronDownRegular />
      </button>
      {open && (
        <Popover anchor={anchor.current} onClose={close} className="menu-popover">
          <div role="menu" className="menu-list">
            <div className="menu-heading">Notebooks</div>
            {notebooks.map((n) => (
              <button
                key={n.id}
                role="menuitemradio"
                aria-checked={n.id === sel.notebookId}
                className="menu-item"
                onClick={() => {
                  selection.selectNotebook(n.id);
                  patchUi(ui, { view: 'page' });
                  close();
                }}
              >
                <span className="menu-icon">
                  <NotebookFilled style={{ color: colorHex(n.color) }} />
                </span>
                <span className="menu-label">{n.name || 'Untitled notebook'}</span>
                {n.id === sel.notebookId && <CheckmarkRegular className="menu-check" />}
              </button>
            ))}
            <div className="menu-separator" />
            <button className="menu-item" onClick={() => (close(), commands.run('new-notebook'))}>
              <span className="menu-icon"><AddRegular /></span>New notebook
            </button>
            <button className="menu-item" onClick={() => (close(), commands.run('import-onenote'))}>
              <span className="menu-icon"><ArrowImportRegular /></span>Import from OneNote
            </button>
            {current && (
              <>
                <div className="menu-separator" />
                <button className="menu-item" onClick={() => (close(), patchUi(ui, { renaming: current.id }))}>
                  <span className="menu-icon"><RenameRegular /></span>Rename notebook
                </button>
                <button
                  className="menu-item"
                  onClick={() => (close(), patchUi(ui, { dialog: { kind: 'export', scope: 'notebook', notebookId: current.id } }))}
                >
                  <span className="menu-icon"><ArrowDownloadRegular /></span>Export notebook…
                </button>
                <div className="menu-swatches" role="group" aria-label="Notebook colour">
                  {COLORS.map((c) => (
                    <button
                      key={c.name}
                      className={`swatch ${c.name === current.color ? 'is-selected' : ''}`}
                      style={{ background: c.hex }}
                      aria-label={`Notebook colour: ${c.name}`}
                      onClick={() => setNotebookColor(library, current.id, c.name)}
                    />
                  ))}
                </div>
                <button className="menu-item is-danger" onClick={() => (close(), deleteNotebook(library, current.id))}>
                  <span className="menu-icon"><DeleteRegular /></span>Delete notebook
                </button>
              </>
            )}
          </div>
        </Popover>
      )}
    </div>
  );
}
