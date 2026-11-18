/**
 * "Add a board" on a notebook: a key that follows the notebook's name until
 * it is edited by hand. The new board gets the default statuses and opens.
 */
import { useEffect, useState, type FormEvent } from 'react';
import {
  BOARD_KEY_MAX_LENGTH,
  boardDocId,
  createBoard,
  getNotebook,
  listNotebooks,
  normalizeBoardKey,
  readBoardMeta,
  suggestBoardKey,
} from '@looseleaf/model';
import { Dialog } from '../app/controls.js';
import { useServices } from '../app/services.js';
import { patchUi } from '../app/ui-state.js';

export function NewBoardDialog({ notebookId, onClose }: { notebookId: string; onClose: () => void }) {
  const { access, library, selection, ui } = useServices();
  const notebookName = getNotebook(library, notebookId)?.name ?? '';
  const [taken, setTaken] = useState<string[]>([]);
  const [key, setKey] = useState('');
  const [keyEdited, setKeyEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shownKey = keyEdited ? key : suggestBoardKey(notebookName, taken);
  const keyTaken = keyEdited && taken.includes(key);

  // The keys of every other board on this device, so the new key can be told apart from them.
  useEffect(() => {
    let cancelled = false;
    const others = listNotebooks(library, { includeDeleted: true }).filter((n) => n.id !== notebookId);
    Promise.all(others.map((n) => access.withDoc(boardDocId(n.id), (doc) => readBoardMeta(doc)?.key ?? null))).then(
      (keys) => !cancelled && setTaken(keys.filter((k): k is string => k !== null)),
      (failure: unknown) => console.error('Could not read the other boards’ keys', failure),
    );
    return () => {
      cancelled = true;
    };
  }, [access, library, notebookId]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      await access.withDoc(boardDocId(notebookId), (doc) => createBoard(doc, { notebookId, name: notebookName, key: shownKey, takenKeys: taken }));
      selection.selectNotebook(notebookId);
      patchUi(ui, { dialog: null, view: 'board', boardPage: null, railPanel: 'notebooks', phonePane: 'page' });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      setBusy(false);
    }
  };

  return (
    <Dialog title="Add a board" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <p className="muted">A board shows this notebook’s pages as cards in statuses. Any page can go on it.</p>
        <div className="field">
          <label htmlFor="new-board-key">Key</label>
          <input
            id="new-board-key"
            className="key-input"
            value={shownKey}
            onChange={(e) => {
              setKeyEdited(true);
              setKey(normalizeBoardKey(e.target.value));
            }}
            maxLength={BOARD_KEY_MAX_LENGTH}
            spellCheck={false}
            autoCapitalize="characters"
            aria-describedby="board-key-hint"
            autoFocus
          />
          <small id="board-key-hint" className={`field-hint ${keyTaken ? 'is-error' : ''}`}>
            {keyTaken
              ? `${key} is taken; the board gets the next free key.`
              : `Cards on this board are named ${shownKey || 'KEY'}-1, ${shownKey || 'KEY'}-2 and so on. The key can’t be changed later.`}
          </small>
        </div>
        <p className="form-error" role="alert">
          {error ?? ''}
        </p>
        <div className="form-actions">
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button primary" disabled={busy}>
            Add board
          </button>
        </div>
      </form>
    </Dialog>
  );
}
