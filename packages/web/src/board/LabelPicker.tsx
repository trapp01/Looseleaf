/** The card strip's label control: tick the board's labels on or off, or make a new one and put it on the card. */
import { useState, type FormEvent } from 'react';
import { createLabel, labelCard, leastUsedLabelColor, type Card, type LabelColor } from '@looseleaf/model';
import { Popover } from '../app/controls.js';
import { useServices } from '../app/services.js';
import { LabelChip } from './LabelChip.js';
import { LabelColorSwatches } from './LabelColorSwatches.js';
import type { CurrentBoard } from './live-board.js';

export function LabelPicker({ current, card, anchor, onClose }: { current: CurrentBoard; card: Card; anchor: HTMLElement | null; onClose: () => void }) {
  const { access } = useServices();
  const { doc, board, notebookId } = current;
  const [name, setName] = useState('');
  const [color, setColor] = useState<LabelColor>(() => leastUsedLabelColor(board.labels.map((label) => label.color)));
  const setLabel = (labelId: string, on: boolean) =>
    void labelCard(access, { notebookId, pageId: card.id, labelId, on }).catch((error: unknown) => console.error('Could not label the card', error));
  const create = (event: FormEvent) => {
    event.preventDefault();
    if (name.trim() === '') return;
    const label = createLabel(doc, { name, color });
    setLabel(label.id, true);
    setName('');
    setColor(leastUsedLabelColor([...board.labels.map((existing) => existing.color), color]));
  };
  return (
    <Popover anchor={anchor} onClose={onClose} className="label-picker">
      <div role="dialog" aria-label="Labels" className="label-picker-body">
        {board.labels.length > 0 && (
          <ul className="check-list">
            {board.labels.map((label) => (
              <li key={label.id}>
                <label className="check-row">
                  <input type="checkbox" checked={card.labelIds.includes(label.id)} onChange={(e) => setLabel(label.id, e.target.checked)} />
                  <LabelChip label={label} />
                </label>
              </li>
            ))}
          </ul>
        )}
        <form className="stack label-create" onSubmit={create}>
          <label className="field">
            <span>New label</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name, such as Garden" maxLength={40} />
          </label>
          <LabelColorSwatches value={color} onChange={setColor} />
          <div className="form-actions">
            <button type="submit" className="button primary" disabled={name.trim() === ''}>
              Create label
            </button>
          </div>
        </form>
      </div>
    </Popover>
  );
}
