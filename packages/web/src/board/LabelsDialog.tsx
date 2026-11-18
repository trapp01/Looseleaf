/**
 * The board's labels: create, rename, recolour, tie to a section, and delete.
 * A label's tie files new cards' pages in that section and moves no page that
 * exists. Deleting takes the label off every card, so it asks first and says
 * how many cards carry it.
 */
import { useState, type FormEvent } from 'react';
import { DeleteRegular, EditRegular } from '@fluentui/react-icons';
import { createLabel, deleteLabel, leastUsedLabelColor, updateLabel, type Label, type LabelColor, type SectionEntry } from '@looseleaf/model';
import { Dialog, IconButton } from '../app/controls.js';
import { allSections } from '../app/selection.js';
import { useNotebookTree } from '../nav/notebook-docs.js';
import { LabelChip } from './LabelChip.js';
import { LabelColorSwatches } from './LabelColorSwatches.js';
import type { CurrentBoard } from './live-board.js';

export function LabelsDialog({ current, onClose }: { current: CurrentBoard; onClose: () => void }) {
  const { doc, board } = current;
  const sections = allSections(useNotebookTree(current.notebookDoc).children);
  const [editing, setEditing] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [color, setColor] = useState<LabelColor>(() => leastUsedLabelColor(board.labels.map((label) => label.color)));
  const [section, setSection] = useState<string | null>(null);

  const create = (event: FormEvent) => {
    event.preventDefault();
    if (name.trim() === '') return;
    createLabel(doc, { name, color, section });
    setName('');
    setSection(null);
    setColor(leastUsedLabelColor([...board.labels.map((label) => label.color), color]));
  };

  return (
    <Dialog title="Labels" onClose={onClose}>
      {board.labels.length === 0 && <p className="muted">Labels say what a card is about. A label tied to a section files new cards’ pages there.</p>}
      <ul className="label-list">
        {board.labels.map((label) =>
          editing === label.id ? (
            <li key={label.id}>
              <LabelEditor label={label} sections={sections} onSave={(changes) => updateLabel(doc, label.id, changes)} onDone={() => setEditing(null)} />
            </li>
          ) : (
            <li key={label.id} className="label-row">
              <LabelChip label={label} />
              <span className="muted small">
                {usage(board.cards.filter((card) => card.labelIds.includes(label.id)).length)}
                {label.section !== null && ` · Files in ${sections.find((s) => s.id === label.section)?.name ?? 'a deleted section'}`}
              </span>
              <span className="spacer" />
              {confirming === label.id ? (
                <span className="confirm-inline">
                  <span className="small">Delete and take it off every card?</span>
                  <button type="button" className="button danger" onClick={() => deleteLabel(doc, label.id)}>
                    Delete
                  </button>
                  <button type="button" className="button" onClick={() => setConfirming(null)}>
                    Keep
                  </button>
                </span>
              ) : (
                <>
                  <IconButton label={`Edit ${label.name}`} onClick={() => setEditing(label.id)}>
                    <EditRegular />
                  </IconButton>
                  <IconButton label={`Delete ${label.name}`} onClick={() => setConfirming(label.id)}>
                    <DeleteRegular />
                  </IconButton>
                </>
              )}
            </li>
          ),
        )}
      </ul>
      <form className="stack section-gap" onSubmit={create}>
        <h3>New label</h3>
        <label className="field">
          <span>Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Such as Garden or Repairs" maxLength={40} />
        </label>
        <LabelColorSwatches value={color} onChange={setColor} />
        <SectionTie value={section} sections={sections} onChange={setSection} />
        <div className="form-actions">
          <button type="submit" className="button primary" disabled={name.trim() === ''}>
            Create label
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function usage(count: number): string {
  return count === 0 ? 'On no cards' : count === 1 ? 'On 1 card' : `On ${count} cards`;
}

/** The label tie as a choice of the notebook's sections, or none. */
function SectionTie({ value, sections, onChange }: { value: string | null; sections: SectionEntry[]; onChange: (section: string | null) => void }) {
  const known = value === null || sections.some((s) => s.id === value);
  return (
    <label className="field">
      <span>New cards with this label go in</span>
      <select value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
        <option value="">No section of its own</option>
        {!known && <option value={value!}>A deleted section</option>}
        {sections.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name || 'Untitled section'}
          </option>
        ))}
      </select>
    </label>
  );
}

function LabelEditor({
  label,
  sections,
  onSave,
  onDone,
}: {
  label: Label;
  sections: SectionEntry[];
  onSave: (changes: { name: string; color: LabelColor; section: string | null }) => void;
  onDone: () => void;
}) {
  const [name, setName] = useState(label.name);
  const [color, setColor] = useState<LabelColor>(label.color);
  const [section, setSection] = useState<string | null>(label.section);
  const save = (event: FormEvent) => {
    event.preventDefault();
    if (name.trim() === '') return;
    onSave({ name, color, section });
    onDone();
  };
  return (
    <form className="stack label-editor" onSubmit={save}>
      <label className="field">
        <span>Name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={40} />
      </label>
      <LabelColorSwatches value={color} onChange={setColor} />
      <SectionTie value={section} sections={sections} onChange={setSection} />
      <div className="form-actions">
        <button type="button" className="button" onClick={onDone}>
          Cancel
        </button>
        <button type="submit" className="button primary" disabled={name.trim() === ''}>
          Save
        </button>
      </div>
    </form>
  );
}
