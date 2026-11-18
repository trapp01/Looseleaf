/**
 * The "Add a card" composer at the top of a status. Enter adds the card above
 * the others (a new page with that title, filed by `addCard`) and keeps the
 * composer open for the next; Escape, or leaving it empty, closes it.
 */
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { DismissRegular } from '@fluentui/react-icons';
import { addCard } from '@looseleaf/model';
import { IconButton } from '../app/controls.js';
import { useServices } from '../app/services.js';

/** `onAdded` runs after each card is added, so the status can show its top, where the card went. */
export function CardComposer({ notebookId, statusId, onAdded, onClose }: { notebookId: string; statusId: string; onAdded: () => void; onClose: () => void }) {
  const { access, actor } = useServices();
  const [title, setTitle] = useState('');
  const field = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    field.current?.focus();
    field.current?.scrollIntoView({ block: 'nearest' });
  }, []);

  const add = () => {
    if (title.trim() === '') return;
    addCard(access, { notebookId, title, statusId, place: 'top', by: actor.get() }).then(onAdded, (error: unknown) => console.error('Could not add the card', error));
    setTitle('');
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      add();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    }
  };

  return (
    <form
      className="card-composer"
      onSubmit={(event) => {
        event.preventDefault();
        add();
        field.current?.focus();
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null) && title.trim() === '') onClose();
      }}
    >
      <textarea
        ref={field}
        className="composer-field"
        aria-label="Card title"
        placeholder="Card title"
        value={title}
        rows={2}
        onChange={(e) => setTitle(e.target.value.replace(/\n/g, ' '))}
        onKeyDown={onKeyDown}
      />
      <div className="composer-actions">
        <button type="submit" className="button primary" disabled={title.trim() === ''}>
          Add card
        </button>
        <IconButton label="Close" onClick={onClose}>
          <DismissRegular />
        </IconButton>
      </div>
    </form>
  );
}
