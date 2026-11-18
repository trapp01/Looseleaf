/**
 * Corkboard's boards as plain objects, read from a Corkboard server's data
 * folder through `DataFolderReader`, so the folder is never written. Corkboard
 * keeps its list of boards in the `workspace` doc (`boards`: boardId → name,
 * key, createdAt, archivedAt, …) and each board in `board:<boardId>`
 * (`statuses`, `labels`, `cards`). A card there holds its own title,
 * Markdown description (a Y.Text), checklist (itemId → text, done, order) and
 * attachments (attachmentId → blob, name, mime, size, at) beside the fields a
 * Looseleaf card has. Fields are read the way Corkboard's own reader reads
 * them; comments, links, attachments and activity entries are kept whole.
 */
import * as Y from 'yjs';
import { STATUS_KINDS, labelColorOr, sortByOrder, type Activity, type Comment, type LabelColor, type Link, type StatusKind } from '@looseleaf/model';
import type { DataFolderReader } from './data-folder-reader.js';

export const CORKBOARD_WORKSPACE_DOC_ID = 'workspace';

export interface CorkboardBoardEntry {
  id: string;
  name: string;
  key: string;
  createdAt: number;
  archivedAt: number | null;
}

export interface CorkboardStatus {
  id: string;
  name: string;
  kind: StatusKind;
  order: string;
  archivedAt: number | null;
}

export interface CorkboardLabel {
  id: string;
  name: string;
  color: LabelColor;
  order: string;
}

export interface CorkboardChecklistItem {
  id: string;
  text: string;
  done: boolean;
  order: string;
}

export interface CorkboardAttachment {
  id: string;
  /** SHA-256 hex of the bytes. */
  blob: string;
  name: string;
  mime: string;
  size: number;
  at: number;
}

export interface CorkboardCard {
  id: string;
  number: number;
  title: string;
  statusId: string;
  order: string;
  /** Markdown. */
  description: string;
  labelIds: string[];
  due: string | null;
  /** In checklist order. */
  checklist: CorkboardChecklistItem[];
  /** Oldest first, as Corkboard lists them. */
  comments: Comment[];
  links: Link[];
  attachments: CorkboardAttachment[];
  activity: Activity[];
  createdAt: number;
  createdBy: string;
  updatedAt: number;
  archivedAt: number | null;
}

export interface CorkboardBoard {
  entry: CorkboardBoardEntry;
  /** Every status in board order, archived ones in their place. */
  statuses: CorkboardStatus[];
  labels: CorkboardLabel[];
  /** Status by status in board order, top first, archived cards in their place; cards whose status the board lacks come last. */
  cards: CorkboardCard[];
}

/** Every board in the workspace, archived ones included, in no particular order. */
export async function listCorkboardBoards(folder: DataFolderReader): Promise<CorkboardBoardEntry[]> {
  const workspace = await folder.readDoc(CORKBOARD_WORKSPACE_DOC_ID);
  const boards: CorkboardBoardEntry[] = [];
  workspace.getMap<Y.Map<unknown>>('boards').forEach((map, id) => {
    boards.push({
      id,
      name: String(map.get('name') ?? ''),
      key: String(map.get('key') ?? ''),
      createdAt: Number(map.get('createdAt') ?? 0),
      archivedAt: (map.get('archivedAt') as number | null | undefined) ?? null,
    });
  });
  return boards.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
}

/** The board's doc as plain objects. Throws UnreadableDocError when the doc is damaged. */
export async function readCorkboardBoard(folder: DataFolderReader, entry: CorkboardBoardEntry): Promise<CorkboardBoard> {
  const doc = await folder.readDoc(`board:${entry.id}`);
  const statuses: CorkboardStatus[] = [];
  doc.getMap<Y.Map<unknown>>('statuses').forEach((map, id) => {
    const kind = map.get('kind');
    statuses.push({
      id,
      name: String(map.get('name') ?? ''),
      kind: STATUS_KINDS.includes(kind as StatusKind) ? (kind as StatusKind) : 'todo',
      order: String(map.get('order') ?? ''),
      archivedAt: (map.get('archivedAt') as number | null | undefined) ?? null,
    });
  });
  const labels: CorkboardLabel[] = [];
  doc.getMap<Y.Map<unknown>>('labels').forEach((map, id) => {
    labels.push({ id, name: String(map.get('name') ?? ''), color: labelColorOr(map.get('color')), order: String(map.get('order') ?? '') });
  });
  const cards: CorkboardCard[] = [];
  doc.getMap<Y.Map<unknown>>('cards').forEach((map, id) => cards.push(readCard(id, map)));
  const sortedStatuses = sortByOrder(statuses);
  const rank = new Map(sortedStatuses.map((status, index) => [status.id, index]));
  const byStatus = (card: CorkboardCard) => rank.get(card.statusId) ?? sortedStatuses.length;
  const sortedCards = sortByOrder(cards).sort((a, b) => byStatus(a) - byStatus(b));
  return { entry, statuses: sortedStatuses, labels: sortByOrder(labels), cards: sortedCards };
}

/** The entries of a card's nested map as plain objects carrying their id, oldest first, each as stored. */
function readEntries<T>(card: Y.Map<unknown>, field: string): T[] {
  const map = card.get(field);
  if (!(map instanceof Y.Map)) return [];
  const entries: Array<{ id: string; at: number }> = [];
  map.forEach((value, id) => {
    if (typeof value === 'object' && value !== null) entries.push({ ...(value as { at: number }), id });
  });
  return entries.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1)) as T[];
}

function readChecklist(card: Y.Map<unknown>): CorkboardChecklistItem[] {
  const map = card.get('checklist');
  if (!(map instanceof Y.Map)) return [];
  const items: CorkboardChecklistItem[] = [];
  map.forEach((value, id) => {
    if (!(value instanceof Y.Map)) return;
    items.push({ id, text: String(value.get('text') ?? ''), done: value.get('done') === true, order: String(value.get('order') ?? '') });
  });
  return sortByOrder(items);
}

function readCard(id: string, map: Y.Map<unknown>): CorkboardCard {
  const description = map.get('description');
  const labels = map.get('labels');
  const activity = map.get('activity');
  return {
    id,
    number: Number(map.get('number') ?? 0),
    title: String(map.get('title') ?? ''),
    statusId: String(map.get('status') ?? ''),
    order: String(map.get('order') ?? ''),
    description: description instanceof Y.Text ? description.toString() : typeof description === 'string' ? description : '',
    labelIds: labels instanceof Y.Map ? [...labels.keys()] : [],
    due: (map.get('due') as string | null | undefined) ?? null,
    checklist: readChecklist(map),
    comments: readEntries<Comment>(map, 'comments'),
    links: readEntries<Link>(map, 'links'),
    attachments: readEntries<CorkboardAttachment>(map, 'attachments'),
    activity: activity instanceof Y.Array ? (activity.toArray() as Activity[]) : [],
    createdAt: Number(map.get('createdAt') ?? 0),
    createdBy: String(map.get('createdBy') ?? ''),
    updatedAt: Number(map.get('updatedAt') ?? 0),
    archivedAt: (map.get('archivedAt') as number | null | undefined) ?? null,
  };
}
