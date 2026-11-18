/**
 * A board and a card written out as Markdown, the form the MCP endpoint
 * answers in. `renderCard` is the whole card with its page, so a reader needs
 * nothing else to pick the task up; `renderBoard` is the board at a glance.
 * The page text and To Do lines come from the caller, since they live in
 * page docs.
 */
import { pageHash } from '../page-address.js';
import type { TodoLine } from '../todo-lines.js';
import { cardLabels, cardsInStatus, checklistProgress, findStatus, shownStatusId, type Activity, type BoardSnapshot, type Card } from './board.js';
import type { InboxLine } from './inbox.js';
import { formatCardRef, parseLinkTarget } from './refs.js';

export interface RenderOptions {
  /** The board's name: its notebook's name. */
  name: string;
  /** The server's address, e.g. `http://nas:8421`; page addresses are left out without it. */
  baseUrl?: string;
  /** Each card's To Do lines by page id, for checklist counts and the card's checklist. */
  checklists?: ReadonlyMap<string, readonly TodoLine[]>;
}

export interface BoardRenderOptions extends RenderOptions {
  /** Cards listed per status before the rest are counted; every card when left out. */
  cardsPerStatus?: number;
  /** The Inbox lane (`inboxLines`); left out when not given. */
  inbox?: readonly InboxLine[];
}

export interface CardRenderOptions extends RenderOptions {
  /** The card's page as Markdown, without its title line. */
  page?: string;
  /** Text to show under a link, keyed by the link's target: the content of a linked page. */
  linkedText?: ReadonlyMap<string, string>;
}

function day(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}

function minute(time: number): string {
  return new Date(time).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}

function address(baseUrl: string, pageId: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${pageHash(pageId)}`;
}

/** One line for a card in a list: its ref, title and what is on it. */
export function renderCardLine(board: BoardSnapshot, card: Card, checklist: readonly TodoLine[] = []): string {
  const parts = [`${formatCardRef(board.meta.key, card.number)} ${card.title || 'Untitled page'}`];
  const labels = cardLabels(board, card).map((label) => label.name);
  if (labels.length > 0) parts.push(`[${labels.join(', ')}]`);
  if (card.due !== null) parts.push(`due ${card.due}`);
  const progress = checklistProgress(checklist);
  if (progress.total > 0) parts.push(`checklist ${progress.done}/${progress.total}`);
  if (card.comments.length > 0) parts.push(`${card.comments.length} comment${card.comments.length === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

/** The board at a glance: the Inbox when given, then every status in order with its cards, top first. */
export function renderBoard(board: BoardSnapshot, options: BoardRenderOptions): string {
  const lines = [`# ${options.name} (${board.meta.key})`, ''];
  if (board.labels.length > 0) lines.push(`Labels: ${board.labels.map((label) => label.name).join(', ')}`, '');
  if (options.inbox !== undefined) {
    const count = options.inbox.length;
    lines.push(`## Inbox (${count} line${count === 1 ? '' : 's'})`, '');
    const shown = options.cardsPerStatus === undefined ? options.inbox : options.inbox.slice(0, options.cardsPerStatus);
    for (const line of shown) lines.push(`- ${line.text} · on "${line.pageTitle || 'Untitled page'}" · line ${line.id}`);
    if (shown.length < count) lines.push(`- … and ${count - shown.length} more`);
    if (count > 0) lines.push('');
  }
  if (board.statuses.length === 0) lines.push('This board has no statuses yet.');
  for (const status of board.statuses) {
    const cards = cardsInStatus(board, status.id);
    lines.push(`## ${status.name} (${status.kind}, ${cards.length} card${cards.length === 1 ? '' : 's'})`, '');
    const shown = options.cardsPerStatus === undefined ? cards : cards.slice(0, options.cardsPerStatus);
    for (const card of shown) lines.push(`- ${renderCardLine(board, card, options.checklists?.get(card.id))}`);
    if (shown.length < cards.length) lines.push(`- … and ${cards.length - shown.length} more`);
    if (cards.length > 0) lines.push('');
  }
  return lines.join('\n').trimEnd() + '\n';
}

function activityLine(entry: Activity): string {
  switch (entry.type) {
    case 'created':
      return `${entry.by} created this card in ${entry.status}`;
    case 'moved':
      return `${entry.by} moved it from ${entry.from} to ${entry.to}`;
    case 'archived':
      return `${entry.by} archived it`;
    case 'restored':
      return `${entry.by} restored it`;
  }
}

/** Everything on one card: where it stands, its page, its checklist, links, comments and history. */
export function renderCard(board: BoardSnapshot, card: Card, options: CardRenderOptions): string {
  const ref = formatCardRef(board.meta.key, card.number);
  const status = findStatus(board, card.statusId);
  const hidden =
    card.sectionId === null
      ? ' — its page is deleted'
      : card.archivedAt !== null
        ? ' — archived'
        : shownStatusId(board, card) === null
          ? ' — in an archived status'
          : '';
  const labels = cardLabels(board, card).map((label) => label.name);
  const lines = [`# ${ref} ${card.title || 'Untitled page'}`, ''];
  lines.push(`- Board: ${options.name}`);
  lines.push(`- Status: ${status === null ? 'unknown' : `${status.name} (${status.kind})`}${hidden}`);
  if (status !== null && hidden === '') {
    const siblings = cardsInStatus(board, status.id);
    lines.push(`- Position: ${siblings.findIndex((sibling) => sibling.id === card.id) + 1} of ${siblings.length} in ${status.name}`);
  }
  lines.push(`- Labels: ${labels.length > 0 ? labels.join(', ') : 'none'}`);
  if (card.due !== null) lines.push(`- Due: ${card.due}`);
  lines.push(`- Created: ${day(card.createdAt)} by ${card.createdBy}`);
  lines.push(`- Last changed: ${minute(card.updatedAt)}`);
  if (options.baseUrl) lines.push(`- Address: ${address(options.baseUrl, card.id)}`);
  lines.push(`- Id: ${card.id}`);

  const page = options.page?.trim() ?? '';
  lines.push('', '## Page', '', page === '' ? '_The page is empty._' : page);

  const checklist = options.checklists?.get(card.id) ?? [];
  if (checklist.length > 0) {
    const progress = checklistProgress(checklist);
    lines.push('', `## Checklist (${progress.done}/${progress.total})`, '');
    for (const item of checklist) lines.push(`- [${item.checked ? 'x' : ' '}] ${item.text}${item.id === null ? '' : ` (line ${item.id})`}`);
  }

  if (card.links.length > 0) {
    lines.push('', '## Links', '');
    for (const link of card.links) {
      const target = parseLinkTarget(link.target);
      const where = target?.kind === 'page' ? `page ${target.pageId}` : link.target;
      lines.push(`- ${link.title || where}${link.title ? ` — ${where}` : ''}`);
      const text = options.linkedText?.get(link.target);
      if (text !== undefined && text.trim() !== '') {
        lines.push('', ...text.trim().split('\n').map((line) => `  > ${line}`), '');
      }
    }
  }

  if (card.comments.length > 0) {
    lines.push('', `## Comments (${card.comments.length})`);
    for (const comment of card.comments) {
      lines.push('', `### ${comment.by}, ${minute(comment.at)}${comment.editedAt !== null ? ' (edited)' : ''}`, '', comment.body.trim());
    }
  }

  if (card.activity.length > 0) {
    lines.push('', '## Activity', '');
    for (const activity of card.activity) lines.push(`- ${minute(activity.at)}: ${activityLine(activity)}`);
  }
  return lines.join('\n').trimEnd() + '\n';
}
