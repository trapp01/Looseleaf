/**
 * Comparing a Corkboard board with what an import made of it in Looseleaf,
 * read back from docs (in memory for a dry run, a fresh read of the disk after
 * a real one). It works from the source board, the docs as they were before
 * and the result alone, never from the import's plan: every field is
 * compared, every adopted page is checked to hold exactly what it held before
 * plus new containers, and a total that differs is a mismatch.
 */
import * as Y from 'yjs';
import {
  boardDocId,
  extractPageText,
  formatCardRef,
  getNode,
  listNodes,
  listTodoLines,
  notebookDocId,
  pageDocId,
  parseLinkTarget,
  readBoard,
  readPage,
  unfiledSectionId,
  type Card,
  type Container,
  type NodeEntry,
} from '@looseleaf/model';
import type { CorkboardBoard, CorkboardCard } from './corkboard-folder.js';
import { collapseWhitespace, descriptionText, newPageId, replacedTitleLine } from './corkboard-import.js';

/** Where the check reads the result from. */
export interface ImportResult {
  doc(docId: string): Promise<Y.Doc>;
  /** True when the result holds the blob with the right bytes. */
  blobHeld(hash: string): Promise<boolean>;
}

export interface StatusCount {
  name: string;
  kind: string;
  archived: boolean;
  source: number;
  result: number;
  archivedCardsSource: number;
  archivedCardsResult: number;
}

export interface Total {
  source: number;
  result: number;
}

export interface ImportCheck {
  statusCounts: StatusCount[];
  totals: {
    cards: Total;
    comments: Total;
    /** The result counts the links left on cards; `adoptedAsPages` counts the cards that took a page they linked to, each dropping the link that named it. */
    links: Total & { adoptedAsPages: number };
    checklistItems: Total;
    attachments: Total;
    activityEntries: Total;
  };
  /** One sentence per difference; empty when the result holds everything. */
  mismatches: string[];
}

export interface CheckInput {
  source: CorkboardBoard;
  notebookId: string;
  ties: ReadonlyMap<string, string>;
  result: ImportResult;
  /** A doc as it was before the import. */
  before: (docId: string) => Y.Doc;
  /** Attachments whose blob Corkboard does not hold intact; their blob is not looked for in the result. */
  missingBlobs: ReadonlySet<string>;
}

/** JSON with every object's keys sorted, so two values compare equal whatever order their fields were written in. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_, v: unknown) =>
    v !== null && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1))) : v,
  );
}

const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const byId = <T extends { id: string }>(list: readonly T[]) => [...list].sort((a, b) => (a.id < b.id ? -1 : 1));

/**
 * Compares the source board with the result, card by card from the source.
 * A card is found on the result board by its number; its page is adopted
 * when the notebook held it before. Nothing the import planned is trusted.
 */
export async function checkImport(input: CheckInput): Promise<ImportCheck> {
  const { source, notebookId, result } = input;
  const mismatches: string[] = [];
  const notebookBefore = input.before(notebookDocId(notebookId));
  const notebook = await result.doc(notebookDocId(notebookId));
  const board = readBoard(await result.doc(boardDocId(notebookId)), notebook);

  if (board.meta.key !== source.entry.key) mismatches.push(`The board's key is "${board.meta.key}", not "${source.entry.key}"`);
  const resultStatuses = [...board.statuses, ...board.archivedStatuses];
  for (const status of source.statuses) {
    const found = resultStatuses.find((candidate) => candidate.id === status.id);
    if (!same(found, status)) mismatches.push(`The status "${status.name}" differs: ${JSON.stringify(found ?? null)}`);
  }
  if (resultStatuses.length !== source.statuses.length) mismatches.push(`The board has ${resultStatuses.length} statuses, not ${source.statuses.length}`);
  for (const label of source.labels) {
    const found = board.labels.find((candidate) => candidate.id === label.id);
    const wanted = { ...label, section: input.ties.get(label.id) ?? null };
    if (!same(found, wanted)) mismatches.push(`The label "${label.name}" differs: ${JSON.stringify(found ?? null)}`);
  }
  if (board.labels.length !== source.labels.length) mismatches.push(`The board has ${board.labels.length} labels, not ${source.labels.length}`);

  const resultCards = [...board.cards, ...board.hiddenCards];
  const cardPages: Array<{ pageId: string; adopted: boolean }> = [];
  let checklistItems = 0;
  let attachments = 0;
  let adoptedAsPages = 0;
  for (const card of source.cards) {
    const ref = formatCardRef(source.entry.key, card.number);
    const matches = resultCards.filter((candidate) => candidate.number === card.number);
    if (matches.length !== 1) {
      mismatches.push(`${ref}: ${matches.length} cards on the board have the number ${card.number}`);
      continue;
    }
    const found = matches[0]!;
    if (!board.cards.includes(found)) mismatches.push(`${ref}: page ${found.id} is not live in the notebook`);
    const before = getNode(notebookBefore, found.id);
    const adopted = before !== null;
    cardPages.push({ pageId: found.id, adopted });
    if (!adopted && found.id !== newPageId(card.id)) mismatches.push(`${ref}: its new page has the id ${found.id}, not ${newPageId(card.id)}`);

    const kept = new Set(found.links.map((link) => link.id));
    const dropped = card.links.filter((link) => !kept.has(link.id));
    for (const link of dropped) {
      const target = parseLinkTarget(link.target);
      if (target?.kind !== 'page' || target.pageId !== found.id) mismatches.push(`${ref}: the link to ${link.target} is gone, and it does not name the card's page ${found.id}`);
    }
    if (dropped.length !== (adopted ? 1 : 0)) mismatches.push(`${ref}: ${dropped.length} links are gone; ${adopted ? 'one, the link naming its page,' : 'none'} should be`);
    if (adopted) adoptedAsPages += 1;
    mismatches.push(...compareFields(ref, card, found, new Set(dropped.map((link) => link.id))));

    const page = await result.doc(pageDocId(found.id));
    const counted = await comparePage(ref, card, page, input);
    mismatches.push(...counted.mismatches);
    checklistItems += counted.checklistItems;
    attachments += counted.attachments;
    if (adopted) {
      if (before.name !== '' && before.name !== card.title && !collapseWhitespace(extractPageText(page)).includes(collapseWhitespace(replacedTitleLine(before.name)))) {
        mismatches.push(`${ref}: the page does not hold its old title "${before.name}"`);
      }
      mismatches.push(...comparePreserved(ref, input.before(pageDocId(found.id)), page));
    }
  }
  const numbers = new Set(source.cards.map((card) => card.number));
  for (const card of resultCards) {
    if (!numbers.has(card.number)) mismatches.push(`Page ${card.id} is a card with the number ${card.number}, which no Corkboard card has`);
  }
  mismatches.push(...compareNotebook(notebookBefore, notebook, cardPages, notebookId));

  const sum = <T>(list: readonly T[], count: (item: T) => number) => list.reduce((total, item) => total + count(item), 0);
  const totals: ImportCheck['totals'] = {
    cards: { source: source.cards.length, result: resultCards.length },
    comments: { source: sum(source.cards, (card) => card.comments.length), result: sum(resultCards, (card) => card.comments.length) },
    links: { source: sum(source.cards, (card) => card.links.length), result: sum(resultCards, (card) => card.links.length), adoptedAsPages },
    checklistItems: { source: sum(source.cards, (card) => card.checklist.length), result: checklistItems },
    attachments: { source: sum(source.cards, (card) => card.attachments.length), result: attachments },
    activityEntries: { source: sum(source.cards, (card) => card.activity.length), result: sum(resultCards, (card) => card.activity.length) },
  };
  for (const [name, total] of Object.entries(totals)) {
    const expected = name === 'links' ? total.source - adoptedAsPages : total.source;
    if (total.result !== expected) mismatches.push(`The result has ${total.result} ${name === 'activityEntries' ? 'activity entries' : name === 'checklistItems' ? 'checklist items' : name}, not ${expected}`);
  }
  return { statusCounts: statusCounts(source, resultCards, resultStatuses), totals, mismatches };
}

function compareFields(ref: string, card: CorkboardCard, found: Card, dropped: ReadonlySet<string>): string[] {
  const wanted = {
    number: card.number,
    title: card.title,
    statusId: card.statusId,
    order: card.order,
    labelIds: [...card.labelIds].sort(),
    due: card.due,
    comments: byId(card.comments),
    links: byId(card.links.filter((link) => !dropped.has(link.id))),
    activity: card.activity,
    createdAt: card.createdAt,
    createdBy: card.createdBy,
    updatedAt: card.updatedAt,
    archivedAt: card.archivedAt,
  };
  const got = {
    number: found.number,
    title: found.title,
    statusId: found.statusId,
    order: found.order,
    labelIds: [...found.labelIds].sort(),
    due: found.due,
    comments: byId(found.comments),
    links: byId(found.links),
    activity: found.activity,
    createdAt: found.createdAt,
    createdBy: found.createdBy,
    updatedAt: found.updatedAt,
    archivedAt: found.archivedAt,
  };
  return (Object.keys(wanted) as Array<keyof typeof wanted>)
    .filter((field) => !same(wanted[field], got[field]))
    .map((field) => `${ref}: ${field} is ${JSON.stringify(got[field])}, not ${JSON.stringify(wanted[field])}`);
}

/** The description, the old title, the checklist in order and every attachment, found on the page. */
async function comparePage(
  ref: string,
  card: CorkboardCard,
  page: Y.Doc,
  input: CheckInput,
): Promise<{ mismatches: string[]; checklistItems: number; attachments: number }> {
  const mismatches: string[] = [];
  const text = collapseWhitespace(extractPageText(page));
  const description = await descriptionText(card.description);
  if (description !== '' && !text.includes(description)) mismatches.push(`${ref}: the page does not hold the description`);

  const lines = listTodoLines(page);
  let next = 0;
  let checklistItems = 0;
  for (const item of card.checklist) {
    const at = lines.findIndex((line, index) => index >= next && line.text === item.text && line.checked === item.done);
    if (at === -1) {
      mismatches.push(`${ref}: the checklist item "${item.text}" (${item.done ? 'ticked' : 'not ticked'}) is not a To Do line on the page in its place`);
      continue;
    }
    checklistItems += 1;
    next = at + 1;
  }

  const files = readPage(page).containers.flatMap((container) => (container.kind === 'text' ? [] : [container]));
  let attachments = 0;
  for (const attachment of card.attachments) {
    const at = files.findIndex((container) => container.blob === attachment.blob && container.name === attachment.name && container.size === attachment.size);
    if (at === -1) {
      mismatches.push(`${ref}: the attachment "${attachment.name}" is not on the page`);
      continue;
    }
    files.splice(at, 1);
    attachments += 1;
    if (!input.missingBlobs.has(attachment.blob) && !(await input.result.blobHeld(attachment.blob))) {
      mismatches.push(`${ref}: the blob of "${attachment.name}" (${attachment.blob}) is not in Looseleaf's blob store`);
    }
  }
  return { mismatches, checklistItems, attachments };
}

/** Every container and stroke the page held before is still there exactly as it was; the import only adds containers. */
function comparePreserved(ref: string, before: Y.Doc, after: Y.Doc): string[] {
  const mismatches: string[] = [];
  const was = readPage(before);
  const now = readPage(after);
  const nowById = new Map<string, Container>(now.containers.map((container) => [container.id, container]));
  for (const container of was.containers) {
    const found = nowById.get(container.id);
    if (found === undefined) {
      mismatches.push(`${ref}: the container ${container.id} the page held before is gone`);
    } else if (!same(container, found)) {
      mismatches.push(`${ref}: the container ${container.id} changed`);
    }
  }
  if (!same(was.strokes, now.strokes)) mismatches.push(`${ref}: the page's strokes changed`);
  if (!same(was.meta, now.meta)) mismatches.push(`${ref}: the page's paper changed`);
  return mismatches;
}

/** Every node the notebook held before is still there unchanged, but for the titles and times of adopted pages; the only new nodes are new cards' pages and the Unfiled section. */
function compareNotebook(before: Y.Doc, after: Y.Doc, cardPages: ReadonlyArray<{ pageId: string; adopted: boolean }>, notebookId: string): string[] {
  const mismatches: string[] = [];
  const adopted = new Set(cardPages.filter((card) => card.adopted).map((card) => card.pageId));
  const made = new Set(cardPages.filter((card) => !card.adopted).map((card) => card.pageId));
  const ids = new Set(listNodes(before).map((node) => node.id));
  const unchanged = (node: NodeEntry) => {
    const { name, modifiedAt, ...rest } = node;
    return adopted.has(node.id) ? rest : { ...rest, name, modifiedAt };
  };
  for (const id of ids) {
    const was = getNode(before, id)!;
    const now = getNode(after, id);
    if (now === null || !same(unchanged(was), unchanged(now))) mismatches.push(`The notebook's node ${id} ("${was.name}") changed`);
  }
  for (const node of listNodes(after)) {
    if (!ids.has(node.id) && !made.has(node.id) && node.id !== unfiledSectionId(notebookId)) mismatches.push(`The notebook has a new node ${node.id} that is no card's page`);
  }
  return mismatches;
}

function statusCounts(source: CorkboardBoard, resultCards: Card[], resultStatuses: Array<{ id: string; name: string; kind: string; archivedAt: number | null }>): StatusCount[] {
  const ids = [...new Set([...source.statuses.map((status) => status.id), ...resultStatuses.map((status) => status.id), ...source.cards.map((card) => card.statusId)])];
  return ids.map((id) => {
    const status = source.statuses.find((candidate) => candidate.id === id) ?? resultStatuses.find((candidate) => candidate.id === id);
    const inSource = source.cards.filter((card) => card.statusId === id);
    const inResult = resultCards.filter((card) => card.statusId === id);
    return {
      name: status?.name ?? `(status ${id}, not on the board)`,
      kind: status?.kind ?? 'todo',
      archived: (status?.archivedAt ?? null) !== null,
      source: inSource.length,
      result: inResult.length,
      archivedCardsSource: inSource.filter((card) => card.archivedAt !== null).length,
      archivedCardsResult: inResult.filter((card) => card.archivedAt !== null).length,
    };
  });
}
