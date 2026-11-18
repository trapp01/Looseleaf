/**
 * Moving a Corkboard board into a Looseleaf notebook, worked out and written
 * on docs held in memory (`ImportDocs`); `corkboard-import-command.ts` decides
 * whether those changes reach the disk. A card becomes a page on the
 * notebook's board: the page named by the first of its `looseleaf:` links
 * whose page is live in the notebook, unless more than one card links to that
 * page, or else a new page with an id made from the card's, filed by its
 * first tied label or in the Unfiled section. The page takes the card's
 * title; the description, the checklist (as To Do lines) and the attachments
 * go into new containers below what the page holds, so nothing already on a
 * page changes. Every board field is written as Corkboard stored it
 * (`writeCardRecord`), so every ref stays the same.
 */
import { createHash } from 'node:crypto';
import * as Y from 'yjs';
import {
  LIBRARY_DOC_ID,
  addFileContainer,
  addImageContainer,
  addTextContainer,
  bodyToText,
  boardDocId,
  createPage,
  ensureUnfiledSection,
  extractPageText,
  filingSection,
  formatCardRef,
  getNode,
  listNotebooks,
  livePages,
  markdownToBody,
  newId,
  notebookDocId,
  pageDocId,
  parseLinkTarget,
  readPage,
  readTree,
  recordUnfiled,
  renameNode,
  tagTodoLine,
  touchNode,
  writeBoardRecord,
  writeCardRecord,
  type Container,
  type JSONContent,
  type Label,
  type Link,
  type TodoLineStamp,
  type TreeChild,
} from '@looseleaf/model';
import type { CorkboardBoard, CorkboardCard } from './corkboard-folder.js';
import type { DataFolderReader } from './data-folder-reader.js';

/** The text written above an adopted page's imported text when the card's title replaced the page's own. */
export function replacedTitleLine(oldTitle: string): string {
  return `Title before the Corkboard import: ${oldTitle}`;
}

/** Text with every run of whitespace made one space and the ends trimmed, for asking whether a page already holds a description. */
export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** A description's words as a page's text reads them: the Markdown made rich text, then plain text, whitespace collapsed. */
export async function descriptionText(markdown: string): Promise<string> {
  if (markdown.trim() === '') return '';
  const { body } = await markdownToBody(markdown, { stamp: { now: () => 0, newId: () => 'x' } });
  return collapseWhitespace(bodyToText(body));
}

/**
 * The id of a card's new page: the Corkboard card's id, or a hash of it when
 * it is not shaped like a page id. The same card always gives the same id, so
 * a dry run and a real run name the same pages and a second run can tell
 * which pages a first one made.
 */
export function newPageId(cardId: string): string {
  return /^[A-Za-z0-9_-]{1,64}$/.test(cardId) ? cardId : createHash('sha256').update(cardId).digest('base64url').slice(0, 21);
}

/**
 * Docs read from a data folder and changed in memory. Each doc is read once;
 * `changes` gives what was written to each as one update, so the same
 * changes can be stored, or dropped for a dry run.
 */
export class ImportDocs {
  private readonly docs = new Map<string, { doc: Y.Doc; updates: Uint8Array[]; vector: Uint8Array }>();

  constructor(private readonly reader: DataFolderReader) {}

  async get(docId: string): Promise<Y.Doc> {
    let loaded = this.docs.get(docId);
    if (loaded === undefined) {
      const updates = await this.reader.readUpdates(docId);
      const doc = new Y.Doc();
      for (const update of updates) Y.applyUpdate(doc, update);
      loaded = { doc, updates, vector: Y.encodeStateVector(doc) };
      this.docs.set(docId, loaded);
    }
    return loaded.doc;
  }

  /** The doc as it was read, as a new doc; empty for a doc never read. */
  before(docId: string): Y.Doc {
    const doc = new Y.Doc();
    for (const update of this.docs.get(docId)?.updates ?? []) Y.applyUpdate(doc, update);
    return doc;
  }

  /** The state vector the doc had when it was read, or null for a doc never read. */
  readVector(docId: string): Uint8Array | null {
    return this.docs.get(docId)?.vector ?? null;
  }

  /** One update per changed doc, holding only what was written here: page docs first, then notebooks, then boards. */
  changes(): Array<{ docId: string; update: Uint8Array }> {
    const rank = (docId: string) => (docId.startsWith('pg:') ? 0 : docId.startsWith('nb:') ? 1 : 2);
    const changed: Array<{ docId: string; update: Uint8Array }> = [];
    for (const [docId, { doc, vector }] of this.docs) {
      if (Buffer.from(Y.encodeStateVector(doc)).equals(Buffer.from(vector))) continue;
      changed.push({ docId, update: Y.encodeStateAsUpdate(doc, vector) });
    }
    return changed.sort((a, b) => rank(a.docId) - rank(b.docId) || (a.docId < b.docId ? -1 : 1));
  }
}

export interface ImportPlanInput {
  source: CorkboardBoard;
  docs: ImportDocs;
  notebookId: string;
  /** Label tie for each tied label: label id → section id. Every section must be live in the notebook. */
  ties: ReadonlyMap<string, string>;
  /** Width and height of each picture attachment whose blob is held and readable, by blob hash. */
  pictureSizes: ReadonlyMap<string, { width: number; height: number }>;
  /** Epoch ms: the board's created time, and the tagged-at time of every To Do line written, so none reaches the Inbox. */
  now: number;
}

export interface PlannedCard {
  ref: string;
  /** The card's id in Corkboard. */
  cardId: string;
  pageId: string;
  page: 'adopted' | 'new';
  sectionId: string;
  /** An adopted page's title before the card's replaced it; null when they were the same or the page is new. */
  replacedTitle: string | null;
  description: 'added' | 'already on the page' | 'empty';
  /** What the description's Markdown could not keep, such as a link to an address the exports refuse. */
  descriptionWarnings: string[];
}

export interface LinkNotAdopted {
  ref: string;
  target: string;
  reason: string;
}

/** A live page of the notebook that several cards link to; none of them takes it as its page. */
export interface SharedPage {
  pageId: string;
  title: string;
  refs: string[];
}

export interface ImportPlan {
  boardKey: string;
  cards: PlannedCard[];
  linksNotAdopted: LinkNotAdopted[];
  sharedPages: SharedPage[];
  /** New pages whose id a notebook node or a page doc already has, as an import that stopped part way leaves them. */
  clashes: Array<{ ref: string; pageId: string }>;
}

const MARGIN_X = 48;
const TEXT_WIDTH = 400;
const GAP = 24;
const FILE_WIDTH = 280;
const FILE_HEIGHT = 64;
const MAX_PICTURE_WIDTH = 640;
const LINE_HEIGHT = 24;
const CHAR_WIDTH = 8;

/**
 * Makes the board and every card in `input.docs`, in board order. Throws when
 * the notebook already has a board. A plan with clashes must not be stored.
 */
export async function planImport(input: ImportPlanInput): Promise<ImportPlan> {
  const { source, docs, notebookId, now } = input;
  const stamp: TodoLineStamp = { now: () => now, newId };
  const board = await docs.get(boardDocId(notebookId));
  const notebook = await docs.get(notebookDocId(notebookId));
  const labels: Label[] = source.labels.map((label) => ({ ...label, section: input.ties.get(label.id) ?? null }));
  writeBoardRecord(board, { key: source.entry.key, createdAt: now, statuses: source.statuses, labels });

  const livePagesAtStart = livePages(notebook);
  const liveSections = liveSectionIds(readTree(notebook).children);
  const otherNotebooks = await otherNotebooksOf(docs, notebookId);
  const refOf = (card: CorkboardCard) => formatCardRef(source.entry.key, card.number);
  const pageLinksOf = (card: CorkboardCard) =>
    card.links.flatMap((link) => {
      const parsed = parseLinkTarget(link.target);
      return parsed?.kind === 'page' ? [{ link, pageId: parsed.pageId }] : [];
    });
  const linkedBy = new Map<string, string[]>();
  for (const card of source.cards) {
    for (const pageId of new Set(pageLinksOf(card).map((link) => link.pageId))) linkedBy.set(pageId, [...(linkedBy.get(pageId) ?? []), refOf(card)]);
  }
  const shared = new Map([...linkedBy].filter(([pageId, refs]) => refs.length > 1 && livePagesAtStart.has(pageId)));

  const made = new Set<string>();
  const cards: PlannedCard[] = [];
  const linksNotAdopted: LinkNotAdopted[] = [];
  const clashes: ImportPlan['clashes'] = [];
  for (const card of source.cards) {
    const ref = refOf(card);
    const pageLinks = pageLinksOf(card);
    const first = pageLinks.find(({ pageId }) => livePagesAtStart.has(pageId));
    const adopted = first !== undefined && !shared.has(first.pageId) ? first : undefined;
    for (const { link, pageId } of pageLinks) {
      if (link === adopted?.link) continue;
      const reason =
        shared.has(pageId) ? `${shared.get(pageId)!.length} cards link to the page, so it is none of their pages`
        : livePagesAtStart.has(pageId) && adopted !== undefined ? 'an earlier link on the card names the page that became the card'
        : livePagesAtStart.has(pageId) ? "the card's first link to a page in the notebook names a page several cards link to, so the card has a new page"
        : getNode(notebook, pageId) !== null ? 'the page or its section is in Deleted notes'
        : otherNotebooks.pageIn(pageId) !== null ? `the page is in the notebook "${otherNotebooks.pageIn(pageId)}"`
        : 'no notebook has the page';
      linksNotAdopted.push({ ref, target: link.target, reason });
    }

    let pageId: string;
    let sectionId: string;
    let replacedTitle: string | null = null;
    if (adopted !== undefined) {
      pageId = adopted.pageId;
      sectionId = livePagesAtStart.get(pageId)!.sectionId;
      const oldTitle = livePagesAtStart.get(pageId)!.title;
      if (oldTitle !== card.title) {
        replacedTitle = oldTitle;
        renameNode(notebook, pageId, card.title);
      }
    } else {
      pageId = newPageId(card.id);
      const inUse =
        made.has(pageId) || getNode(notebook, pageId) !== null || otherNotebooks.holds(pageId) || Y.encodeStateVector(await docs.get(pageDocId(pageId))).length > 1;
      if (inUse) clashes.push({ ref, pageId });
      made.add(pageId);
      const tied = filingSection(labels, card.labelIds, liveSections);
      sectionId = tied ?? ensureUnfiledSection(notebook, notebookId);
      if (tied === null) recordUnfiled(board, sectionId);
      createPage(notebook, { section: sectionId, title: card.title, id: pageId, createdAt: card.createdAt, modifiedAt: now });
    }

    const page = await docs.get(pageDocId(pageId));
    const { description, warnings } = await addPageText(page, card, { adopted: adopted !== undefined, replacedTitle, stamp });
    addAttachments(page, card, input.pictureSizes);
    if (adopted !== undefined && (description === 'added' || replacedTitle || card.checklist.length > 0 || card.attachments.length > 0)) {
      touchNode(notebook, pageId);
    }

    const links: Link[] = card.links.filter((link) => link !== adopted?.link);
    writeCardRecord(board, pageId, {
      number: card.number,
      statusId: card.statusId,
      order: card.order,
      labelIds: card.labelIds,
      due: card.due,
      comments: card.comments,
      links,
      activity: card.activity,
      createdAt: card.createdAt,
      createdBy: card.createdBy,
      updatedAt: card.updatedAt,
      archivedAt: card.archivedAt,
    });
    cards.push({ ref, cardId: card.id, pageId, page: adopted === undefined ? 'new' : 'adopted', sectionId, replacedTitle, description, descriptionWarnings: warnings });
  }
  const sharedPages = [...shared].map(([pageId, refs]) => ({ pageId, title: livePagesAtStart.get(pageId)!.title, refs }));
  return { boardKey: source.entry.key, cards, linksNotAdopted, sharedPages, clashes };
}

/**
 * Adds the old title (when the card's replaced it), the description (unless
 * the page's text already holds it) and the checklist as To Do lines, in one
 * new text container below everything on the page. A container already on
 * the page is never written to, so a replica that deletes one while apart
 * takes none of the imported text with it.
 */
async function addPageText(
  page: Y.Doc,
  card: CorkboardCard,
  options: { adopted: boolean; replacedTitle: string | null; stamp: TodoLineStamp },
): Promise<{ description: PlannedCard['description']; warnings: string[] }> {
  const blocks: JSONContent[] = [];
  if (options.replacedTitle) blocks.push(paragraph(replacedTitleLine(options.replacedTitle)));
  const wanted = await descriptionText(card.description);
  let description: PlannedCard['description'] = 'empty';
  const warnings: string[] = [];
  if (card.description.trim() !== '') {
    if (options.adopted && wanted !== '' && collapseWhitespace(extractPageText(page)).includes(wanted)) description = 'already on the page';
    else {
      description = 'added';
      const made = await markdownToBody(card.description, { stamp: options.stamp });
      blocks.push(...(made.body.content ?? []));
      warnings.push(...made.warnings);
    }
  }
  for (const item of card.checklist) {
    blocks.push({ ...paragraph(item.text), attrs: tagTodoLine({ checked: item.done }, options.stamp) });
  }
  if (blocks.length > 0) {
    const y = contentBottom(readPage(page).containers) + GAP;
    addTextContainer(page, { x: MARGIN_X, y, width: TEXT_WIDTH, body: { type: 'doc', content: blocks } });
  }
  return { description, warnings };
}

function paragraph(text: string): JSONContent {
  return text === '' ? { type: 'paragraph' } : { type: 'paragraph', content: [{ type: 'text', text }] };
}

/** Adds each attachment at the left margin below the page's content, pictures at their size up to the web client's widest. */
function addAttachments(page: Y.Doc, card: CorkboardCard, pictureSizes: ImportPlanInput['pictureSizes']): void {
  let y = contentBottom(readPage(page).containers) + GAP;
  for (const attachment of card.attachments) {
    const ref = { blob: attachment.blob, mime: attachment.mime || 'application/octet-stream', name: attachment.name, size: attachment.size };
    const picture = attachment.mime.startsWith('image/') ? pictureSizes.get(attachment.blob) : undefined;
    if (picture !== undefined) {
      const scale = Math.min(1, MAX_PICTURE_WIDTH / picture.width);
      const width = Math.round(picture.width * scale);
      const height = Math.max(1, Math.round(picture.height * scale));
      addImageContainer(page, { x: MARGIN_X, y, width, height, ...ref });
      y += height + GAP;
    } else {
      addFileContainer(page, { x: MARGIN_X, y, width: FILE_WIDTH, ...ref });
      y += FILE_HEIGHT + GAP;
    }
  }
}

/** The lowest edge of the page's containers. A text container stores no height, so its lines are counted at a typical width. */
function contentBottom(containers: Container[]): number {
  const height = (container: Container): number => {
    if (container.kind === 'image') return container.height;
    if (container.kind === 'file') return FILE_HEIGHT;
    const perLine = Math.max(1, Math.floor(container.width / CHAR_WIDTH));
    const lines = bodyToText(container.body).split('\n').reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / perLine)), 0);
    return lines * LINE_HEIGHT;
  };
  return Math.max(0, ...containers.map((container) => container.y + height(container)));
}

function liveSectionIds(children: TreeChild[], into = new Set<string>()): Set<string> {
  for (const child of children) {
    if (child.kind === 'group') liveSectionIds(child.children, into);
    else into.add(child.id);
  }
  return into;
}

/** The library's other notebooks, deleted ones included: which one holds a page, by name, and whether any holds a node with an id. */
async function otherNotebooksOf(docs: ImportDocs, notebookId: string): Promise<{ pageIn: (pageId: string) => string | null; holds: (id: string) => boolean }> {
  const others: Array<{ name: string; doc: Y.Doc }> = [];
  for (const entry of listNotebooks(await docs.get(LIBRARY_DOC_ID), { includeDeleted: true })) {
    if (entry.id !== notebookId) others.push({ name: entry.name, doc: await docs.get(notebookDocId(entry.id)) });
  }
  return {
    pageIn: (pageId) => others.find(({ doc }) => getNode(doc, pageId)?.kind === 'page')?.name ?? null,
    holds: (id) => others.some(({ doc }) => getNode(doc, id) !== null),
  };
}
