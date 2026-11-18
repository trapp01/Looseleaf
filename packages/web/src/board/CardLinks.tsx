/**
 * The card's links: a web address opens in a new tab; a page, written
 * `looseleaf:<pageId>`, shows the page's title and opens it in the notebook
 * view. Adding a link takes an address and an optional title.
 */
import { useState, type FormEvent } from 'react';
import { DeleteRegular, DocumentRegular, GlobeRegular, LinkRegular } from '@fluentui/react-icons';
import { addLink, getNode, pageHash, parseLinkTarget, removeLink, type Card, type Link } from '@looseleaf/model';
import { IconButton } from '../app/controls.js';
import { useYValue } from '../app/yjs-hooks.js';
import type { CurrentBoard } from './live-board.js';

export function CardLinks({ current, card }: { current: CurrentBoard; card: Card }) {
  const [adding, setAdding] = useState(false);
  const [target, setTarget] = useState('');
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | null>(null);

  const add = (event: FormEvent) => {
    event.preventDefault();
    const typed = target.trim();
    const withScheme = typed && !/^[a-z][a-z0-9+.-]*:/i.test(typed) ? `https://${typed}` : typed;
    const parsed = parseLinkTarget(withScheme);
    if (parsed === null) {
      setError('Enter a web address, or a page as looseleaf:<page id>.');
      return;
    }
    addLink(current.doc, card.id, { target: withScheme, title: title.trim() || (parsed.kind === 'url' ? parsed.url : '') });
    setTarget('');
    setTitle('');
    setError(null);
    setAdding(false);
  };

  return (
    <section className="activity-section" aria-labelledby="card-links-heading">
      <h3 id="card-links-heading" className="activity-heading">
        <LinkRegular aria-hidden="true" />
        Links
      </h3>
      {card.links.length > 0 && (
        <ul className="link-list">
          {card.links.map((link) => (
            <LinkRow key={link.id} current={current} card={card} link={link} />
          ))}
        </ul>
      )}
      {adding ? (
        <form className="stack link-form" onSubmit={add}>
          <label className="field">
            <span>Address</span>
            <input value={target} onChange={(e) => setTarget(e.target.value)} placeholder="https://example.com" autoFocus spellCheck={false} autoCapitalize="off" />
          </label>
          <label className="field">
            <span>Title</span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Such as Seed catalogue" maxLength={200} />
          </label>
          <p className="form-error" role="alert">
            {error ?? ''}
          </p>
          <div className="form-actions start">
            <button type="submit" className="button primary" disabled={target.trim() === ''}>
              Add link
            </button>
            <button
              type="button"
              className="button"
              onClick={() => {
                setAdding(false);
                setError(null);
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <button type="button" className="placeholder-button" onClick={() => setAdding(true)}>
          Add a link
        </button>
      )}
    </section>
  );
}

function LinkRow({ current, card, link }: { current: CurrentBoard; card: Card; link: Link }) {
  const parsed = parseLinkTarget(link.target);
  const pageId = parsed?.kind === 'page' ? parsed.pageId : null;
  const pageTitle = useYValue(current.notebookDoc, () => (pageId ? (getNode(current.notebookDoc, pageId)?.name ?? null) : null), pageId);
  const remove = (
    <IconButton label={`Remove link ${link.title || link.target}`} className="row-action" onClick={() => removeLink(current.doc, card.id, link.id)}>
      <DeleteRegular />
    </IconButton>
  );
  if (parsed?.kind === 'page') {
    return (
      <li className="link-row">
        <a className="link-target" href={pageHash(parsed.pageId)}>
          <DocumentRegular aria-hidden="true" />
          <span className="link-title">{link.title || pageTitle || 'Untitled page'}</span>
          <span className="link-host">{pageTitle === null ? 'A page not on this device' : 'Page'}</span>
        </a>
        {remove}
      </li>
    );
  }
  return (
    <li className="link-row">
      {parsed ? (
        <a className="link-target" href={parsed.url} target="_blank" rel="noopener noreferrer">
          <GlobeRegular aria-hidden="true" />
          <span className="link-title">{link.title || parsed.url}</span>
          <span className="link-host">{hostOf(parsed.url)}</span>
        </a>
      ) : (
        <span className="link-target">
          <span className="link-title">{link.title}</span>
          <span className="link-host">{link.target}</span>
        </span>
      )}
      {remove}
    </li>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
