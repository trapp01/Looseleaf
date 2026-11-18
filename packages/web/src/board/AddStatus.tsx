/** The "Add a status" tile after the last column: a name and a kind. */
import { useState, type FormEvent } from 'react';
import { AddRegular } from '@fluentui/react-icons';
import { createStatus, STATUS_KINDS, type StatusKind } from '@looseleaf/model';
import type * as Y from 'yjs';
import { KIND_NAMES } from './KindMarker.js';

export function AddStatus({ doc }: { doc: Y.Doc }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<StatusKind>('todo');

  if (!open) {
    return (
      <button type="button" className="add-status-tile" onClick={() => setOpen(true)}>
        <AddRegular aria-hidden="true" />
        Add a status
      </button>
    );
  }
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (name.trim() === '') return;
    createStatus(doc, { name, kind });
    setName('');
    setKind('todo');
  };
  return (
    <form
      className="add-status-form"
      onSubmit={submit}
      aria-label="Add a status"
      onKeyDown={(e) => {
        if (e.key === 'Escape') setOpen(false);
      }}
    >
      <label className="field">
        <span>Status name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Such as Review" autoFocus maxLength={60} />
      </label>
      <label className="field">
        <span>Kind</span>
        <select value={kind} onChange={(e) => setKind(e.target.value as StatusKind)}>
          {STATUS_KINDS.map((option) => (
            <option key={option} value={option}>
              {KIND_NAMES[option]}
            </option>
          ))}
        </select>
      </label>
      <div className="form-actions">
        <button type="button" className="button" onClick={() => setOpen(false)}>
          Cancel
        </button>
        <button type="submit" className="button primary" disabled={name.trim() === ''}>
          Add status
        </button>
      </div>
    </form>
  );
}
