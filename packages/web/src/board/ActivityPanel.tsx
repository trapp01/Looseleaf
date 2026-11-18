/**
 * The Activity panel beside a card's page: its links, then its comments and
 * activity together, oldest first, each with its actor and a relative time
 * (the full time on hover), and the comment box at the foot (Cmd/Ctrl+Enter
 * sends). Comments written under this device's name can be edited and
 * deleted.
 */
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ChatRegular, DismissRegular } from '@fluentui/react-icons';
import { addComment, deleteComment, editComment, type Card, type Comment } from '@looseleaf/model';
import { IconButton } from '../app/controls.js';
import { isMac, useServices } from '../app/services.js';
import { useStore } from '../app/store.js';
import { describeTime } from '../sync-ui/status-label.js';
import { CardLinks } from './CardLinks.js';
import { fullTime } from './due.js';
import type { CurrentBoard } from './live-board.js';
import { Markdown } from './Markdown.js';
import { cardTimeline, describeActivity } from './timeline.js';

/** Re-renders every half minute so relative times stay true. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** Whether the panel starts open on a card: only when it has comments or links to show. */
export function activityStartsOpen(card: Card): boolean {
  return card.comments.length > 0 || card.links.length > 0;
}

export function ActivityPanel({ current, card, onClose }: { current: CurrentBoard; card: Card; onClose: () => void }) {
  const { actor } = useServices();
  const me = useStore(actor);
  const now = useNow();
  const [body, setBody] = useState('');
  const list = useRef<HTMLOListElement>(null);
  const entries = cardTimeline(card);

  useEffect(() => {
    list.current?.lastElementChild?.scrollIntoView({ block: 'nearest' });
  }, [entries.length]);

  const send = () => {
    if (body.trim() === '') return;
    addComment(current.doc, card.id, body.trim(), me);
    setBody('');
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      send();
    }
  };
  return (
    <aside className="activity-panel" aria-label="Activity">
      <header className="activity-panel-header">
        <h2>Activity</h2>
        <IconButton label="Close activity" onClick={onClose}>
          <DismissRegular />
        </IconButton>
      </header>
      <div className="activity-scroll">
        <CardLinks current={current} card={card} />
        <section className="activity-section" aria-labelledby="card-timeline-heading">
          <h3 id="card-timeline-heading" className="activity-heading">
            <ChatRegular aria-hidden="true" />
            Comments and activity
          </h3>
          <ol className="timeline" ref={list}>
            {entries.map((entry) =>
              entry.kind === 'comment' ? (
                <CommentEntry key={entry.comment.id} current={current} card={card} comment={entry.comment} mine={entry.comment.by === me} now={now} />
              ) : (
                <li key={entry.key} className="timeline-activity">
                  <span className="actor">{entry.activity.by || 'Someone'}</span> {describeActivity(entry.activity)}{' '}
                  <time dateTime={new Date(entry.at).toISOString()} title={fullTime(entry.at)}>
                    {describeTime(entry.at, now)}
                  </time>
                </li>
              ),
            )}
          </ol>
        </section>
      </div>
      <div className="comment-box">
        <textarea aria-label="Write a comment" placeholder="Write a comment" value={body} onChange={(e) => setBody(e.target.value)} onKeyDown={onKeyDown} rows={2} />
        <div className="form-actions start">
          <button type="button" className="button primary" disabled={body.trim() === ''} onClick={send}>
            Comment
          </button>
          <span className="muted small">{isMac ? '⌘' : 'Ctrl'}+Enter sends</span>
        </div>
      </div>
    </aside>
  );
}

function CommentEntry({ current, card, comment, mine, now }: { current: CurrentBoard; card: Card; comment: Comment; mine: boolean; now: number }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const save = () => {
    if (draft !== null && draft.trim() !== '' && draft.trim() !== comment.body) editComment(current.doc, card.id, comment.id, draft.trim());
    setDraft(null);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      save();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setDraft(null);
    }
  };
  return (
    <li className="timeline-comment">
      <div className="comment-head">
        <span className="actor">{comment.by || 'Someone'}</span>
        <time dateTime={new Date(comment.at).toISOString()} title={fullTime(comment.at)}>
          {describeTime(comment.at, now)}
        </time>
        {comment.editedAt !== null && (
          <span className="muted small" title={`Edited ${fullTime(comment.editedAt)}`}>
            (edited)
          </span>
        )}
      </div>
      {draft === null ? (
        <Markdown className="comment-body" text={comment.body} />
      ) : (
        <div className="stack">
          <textarea aria-label="Edit comment" value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={onKeyDown} autoFocus rows={3} />
          <div className="form-actions start">
            <button type="button" className="button primary" onClick={save}>
              Save
            </button>
            <button type="button" className="button" onClick={() => setDraft(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {mine && draft === null && (
        <div className="comment-actions">
          {confirming ? (
            <>
              <span className="small">Delete this comment?</span>
              <button type="button" className="link-button danger" onClick={() => deleteComment(current.doc, card.id, comment.id)}>
                Delete
              </button>
              <button type="button" className="link-button" onClick={() => setConfirming(false)}>
                Keep
              </button>
            </>
          ) : (
            <>
              <button type="button" className="link-button" onClick={() => setDraft(comment.body)}>
                Edit
              </button>
              <button type="button" className="link-button" onClick={() => setConfirming(true)}>
                Delete
              </button>
            </>
          )}
        </div>
      )}
    </li>
  );
}
