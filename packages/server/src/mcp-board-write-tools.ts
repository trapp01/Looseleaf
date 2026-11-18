/**
 * The MCP board tools that change something: making cards (from a title or
 * from an Inbox line), their title, due day and labels, their checklist,
 * status, comments and links, archiving, and adding statuses, labels and
 * boards. A card is a page, so a card's text and checklist are written on its
 * page. None deletes a card, a status, a board or a To Do line, or rewrites
 * text already on a page; archiving is the one way off a board. Each change
 * goes through the hub, so it reaches every open client at once.
 */
import {
  LABEL_COLORS,
  STATUS_KINDS,
  addCard,
  addComment,
  addLink,
  appendToPage,
  appendTodoLine,
  archiveCard,
  boardDocId,
  changeTodoLines,
  createBoard,
  createLabel,
  createStatus,
  getNode,
  labelCard,
  listTodoLines,
  markdownToBody,
  moveCard,
  notebookDocId,
  pageDocId,
  pageHash,
  parseLinkTarget,
  promoteTodoLine,
  readBoardMeta,
  renameNode,
  restoreCard,
  setCardDue,
  setTodoLineChecked,
  type CardPlace,
  type LabelColor,
  type StatusKind,
  type TodoLine,
} from '@looseleaf/model';
import { CallerError, dueDay, nameCard, resolveLabel, resolveStatus, type BoardEntry, type Boards } from './boards.js';
import { boardArgument, cardArgument } from './mcp-board-read-tools.js';
import type { McpProperty, McpTool } from './mcp-tools.js';

/** The actor recorded for a change when the caller does not give one. */
export const DEFAULT_AUTHOR = 'Agent';

const authorArgument: McpProperty = {
  type: 'string',
  description: `The name recorded as having made this change, shown in the card's activity; "${DEFAULT_AUTHOR}" when left out.`,
};
const writes = { readOnlyHint: false } as const;

function author(args: Record<string, unknown>): string {
  const name = typeof args.author === 'string' ? args.author.trim() : '';
  return name === '' ? DEFAULT_AUTHOR : name;
}

function texts(value: unknown): string[] {
  return Array.isArray(value) ? (value as string[]).map((text) => text.trim()).filter((text) => text !== '') : [];
}

/** A title on one line, or CallerError when nothing is left. */
function title(tool: string, value: unknown): string {
  const text = typeof value === 'string' ? value.replace(/\s*[\r\n]+\s*/g, ' ').trim() : '';
  if (text === '') throw new CallerError(`${tool} needs a title that is not empty.`);
  return text;
}

function nonEmpty(tool: string, field: string, value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text === '') throw new CallerError(`${tool} needs ${field} that is not empty.`);
  return text;
}

function linkTarget(target: string): string {
  if (parseLinkTarget(target) === null) {
    throw new CallerError(`"${target}" is not a link target. Give an http(s) address, or looseleaf:<page id> for a page.`);
  }
  return target.trim();
}

function address(baseUrl: string, pageId: string): string {
  return baseUrl === '' ? '' : `Address: ${baseUrl.replace(/\/+$/, '')}/${pageHash(pageId)}\n`;
}

/** The To Do line a caller named by its line id or by its exact text, ignoring case. */
function lineId(lines: readonly TodoLine[], text: string): string {
  const wanted = text.trim().toLowerCase();
  const line = lines.find((candidate) => candidate.id === text.trim()) ?? lines.find((candidate) => candidate.text.trim().toLowerCase() === wanted);
  if (line === undefined) {
    const known = lines.map((candidate) => `"${candidate.text}"`).join(', ');
    throw new CallerError(`The card's page has no To Do line "${text}". Its lines are: ${known || 'none yet'}. Add one with update_checklist and add.`);
  }
  if (line.id === null) throw new CallerError(`The line "${line.text}" came from an import and has no line id, so it can only be ticked on the page.`);
  return line.id;
}

/** Adds Markdown and To Do lines to the end of a card's page, and marks the page changed. */
async function writeOnPage(boards: Boards, entry: BoardEntry, pageId: string, input: { markdown?: string; lines?: string[] }): Promise<string[]> {
  const converted = input.markdown === undefined || input.markdown.trim() === '' ? null : await markdownToBody(input.markdown);
  const lines = input.lines ?? [];
  if (converted === null && lines.length === 0) return [];
  await changeTodoLines(boards.access, { notebookId: entry.notebookId, pageId }, (doc) => {
    if (converted !== null) appendToPage(doc, converted.body);
    for (const line of lines) appendTodoLine(doc, line);
  });
  return converted?.warnings ?? [];
}

const placeArgument: McpProperty = { type: 'string', description: 'Where in the status the card goes; top when left out.', enum: ['top', 'bottom'] };

export const BOARD_WRITE_TOOLS: readonly McpTool[] = [
  {
    name: 'create_card',
    description:
      'Adds a card to a board and answers with its ref and page id. A card is a page in the board\'s notebook: the ' +
      'title is the page title, the description becomes the page\'s first text and the checklist its To Do lines. ' +
      'Write the title as the task in a few words and the description so someone with no other context could pick it ' +
      'up: what is wanted, why, and how to tell it is finished. The page is filed in the section tied to its first ' +
      'label, or in the Unfiled section. The card goes to the top of the board\'s first todo status unless a status ' +
      'or place is given. Labels must exist on the board. With line (a line id from the Inbox in get_board), the To Do ' +
      'line becomes the card: its text is the title, the line on its page becomes a link to the card, and the card ' +
      'links back to that page.',
    inputSchema: {
      type: 'object',
      properties: {
        board: boardArgument,
        title: { type: 'string', description: 'The task in a few words. Needed unless line is given; with line it renames the card.' },
        line: { type: 'string', description: 'The line id of a To Do line in the board\'s notebook, from the Inbox in get_board.' },
        description: { type: 'string', description: 'Markdown, the first text on the card\'s page.' },
        status: { type: 'string', description: 'A status name, or a kind (todo, doing, done) for the first status of that kind.' },
        place: placeArgument,
        labels: { type: 'array', description: 'Names of labels to put on the card.', items: { type: 'string' } },
        due: { type: 'string', description: 'The due day as YYYY-MM-DD.' },
        checklist: { type: 'array', description: 'To Do lines added to the card\'s page, in order: the steps of the task.', items: { type: 'string' } },
        links: {
          type: 'array',
          description: 'Things the card points at: a branch or pull request address, an issue, or a page.',
          items: {
            type: 'object',
            properties: {
              target: { type: 'string', description: 'An http(s) address, or looseleaf:<page id> for a page.' },
              title: { type: 'string', description: 'What the link is, in a few words.' },
            },
            required: ['target', 'title'],
            additionalProperties: false,
          },
        },
        author: authorArgument,
      },
      additionalProperties: false,
    },
    annotations: writes,
    async run({ boards, baseUrl }, args) {
      const entry = await boards.entry(args.board as string | undefined);
      const board = await boards.open(entry);
      const line = typeof args.line === 'string' ? nonEmpty('create_card', 'a line', args.line) : null;
      const name = line === null || args.title !== undefined ? title('create_card', args.title) : null;
      const due = typeof args.due === 'string' ? dueDay(args.due) : null;
      const labelIds = texts(args.labels).map((label) => resolveLabel(board, label).id);
      const links = ((args.links as Array<{ target: string; title: string }> | undefined) ?? []).map((link) => ({ target: linkTarget(link.target), title: link.title.trim() }));
      if (board.statuses.length === 0) throw new CallerError(`${entry.name} has no statuses yet. Add one with create_status.`);
      const status = typeof args.status === 'string' ? resolveStatus(board, args.status) : (board.statuses.find((candidate) => candidate.kind === 'todo') ?? board.statuses[0]!);
      const place = args.place as CardPlace | undefined;
      const by = author(args);
      const access = boards.access;

      let made: { pageId: string; number: number };
      let from = '';
      if (line === null) {
        made = await addCard(access, { notebookId: entry.notebookId, title: name!, statusId: status.id, place, labelIds, due, by });
      } else {
        const found = await boards.inboxLine(entry, board, line);
        made = await promoteTodoLine(access, { notebookId: entry.notebookId, sourcePageId: found.pageId, lineId: line, statusId: status.id, by });
        from = ` from the line "${found.text}"`;
        if (name !== null) await access.withDoc(notebookDocId(entry.notebookId), (doc) => renameNode(doc, made.pageId, name));
        if (place === 'bottom') await access.withDoc(boardDocId(entry.notebookId), (doc) => moveCard(doc, made.pageId, { statusId: status.id, place }, by));
        if (due !== null) await access.withDoc(boardDocId(entry.notebookId), (doc) => setCardDue(doc, made.pageId, due));
        for (const labelId of labelIds) await labelCard(access, { notebookId: entry.notebookId, pageId: made.pageId, labelId, on: true });
      }
      const warnings = await writeOnPage(boards, entry, made.pageId, { markdown: args.description as string | undefined, lines: texts(args.checklist) });
      if (links.length > 0) {
        await access.withDoc(boardDocId(entry.notebookId), (doc) => {
          for (const link of links) addLink(doc, made.pageId, link);
        });
      }
      const titleNow = name ?? (await access.withDoc(notebookDocId(entry.notebookId), (doc) => getNode(doc, made.pageId)?.name ?? ''));
      const lines = [`Created ${nameCard(entry.key, { number: made.number, title: titleNow })}${from} in ${status.name} (page id: ${made.pageId}).`];
      for (const warning of warnings) lines.push(`Note: ${warning}.`);
      return `${lines.join('\n')}\n${address(baseUrl, made.pageId)}`;
    },
  },
  {
    name: 'update_card',
    description:
      'Changes a card\'s title (its page title), due day or labels. Only what is given changes. A card\'s text is its ' +
      'page: add to it with append_to_page, which takes the card ref; text already on the page is never rewritten. To ' +
      'change the status use move_card; for the checklist use update_checklist.',
    inputSchema: {
      type: 'object',
      properties: {
        card: cardArgument,
        title: { type: 'string', description: 'The new title.' },
        due: { type: 'string', description: 'The due day as YYYY-MM-DD, or "none" to clear it.' },
        add_labels: { type: 'array', description: 'Names of labels to put on the card.', items: { type: 'string' } },
        remove_labels: { type: 'array', description: 'Names of labels to take off the card.', items: { type: 'string' } },
      },
      required: ['card'],
      additionalProperties: false,
    },
    annotations: writes,
    async run({ boards }, args) {
      const { entry, board, card } = await boards.card(args.card as string);
      const name = args.title === undefined ? undefined : title('update_card', args.title);
      const due = typeof args.due === 'string' ? dueDay(args.due) : undefined;
      const adding = texts(args.add_labels).map((label) => resolveLabel(board, label).id);
      const removing = texts(args.remove_labels).map((label) => resolveLabel(board, label).id);
      const access = boards.access;
      if (name !== undefined) {
        const renamed = await access.withDoc(notebookDocId(entry.notebookId), (doc) => {
          if (getNode(doc, card.id) === null) return false;
          renameNode(doc, card.id, name);
          return true;
        });
        if (!renamed) throw new CallerError(`The page of ${nameCard(entry.key, card)} is no longer in ${entry.name}, so its title cannot change here.`);
      }
      if (due !== undefined) await access.withDoc(boardDocId(entry.notebookId), (doc) => setCardDue(doc, card.id, due));
      for (const labelId of adding) await labelCard(access, { notebookId: entry.notebookId, pageId: card.id, labelId, on: true });
      for (const labelId of removing) await labelCard(access, { notebookId: entry.notebookId, pageId: card.id, labelId, on: false });
      return `Updated ${nameCard(entry.key, { number: card.number, title: name ?? card.title })}.\n`;
    },
  },
  {
    name: 'update_checklist',
    description:
      'Changes a card\'s checklist, which is the To Do lines on its page: ticks and unticks lines and adds new ones to ' +
      'the end of the page. Name a line by its line id from get_card or by its exact text. It cannot remove a line or ' +
      'change a line\'s text; a person does that on the page. Tick each step as it is finished so the board shows ' +
      'progress.',
    inputSchema: {
      type: 'object',
      properties: {
        card: cardArgument,
        add: { type: 'array', description: 'Texts of To Do lines to add, in order.', items: { type: 'string' } },
        check: { type: 'array', description: 'Lines to tick.', items: { type: 'string' } },
        uncheck: { type: 'array', description: 'Lines to untick.', items: { type: 'string' } },
      },
      required: ['card'],
      additionalProperties: false,
    },
    annotations: writes,
    async run({ boards }, args) {
      const { entry, card } = await boards.card(args.card as string);
      const before = await boards.todoLines(card.id);
      const check = texts(args.check).map((text) => lineId(before, text));
      const uncheck = texts(args.uncheck).map((text) => lineId(before, text));
      if (check.length > 0 || uncheck.length > 0) {
        await changeTodoLines(boards.access, { notebookId: entry.notebookId, pageId: card.id }, (doc) => {
          for (const id of check) setTodoLineChecked(doc, id, true);
          for (const id of uncheck) setTodoLineChecked(doc, id, false);
        });
      }
      await writeOnPage(boards, entry, card.id, { lines: texts(args.add) });
      const after = await boards.access.withDoc(pageDocId(card.id), listTodoLines);
      return `Checklist of ${nameCard(entry.key, card)} is now ${after.filter((line) => line.checked).length}/${after.length} done.\n`;
    },
  },
  {
    name: 'move_card',
    description:
      'Moves a card to a status, which is how the board shows where a task stands. Move a card to a doing status when ' +
      'work on it starts and to a done status when it is finished. Within a status, higher means more important: the ' +
      'card goes to the bottom unless a place or position is given. An archived card is not moved; restore it first.',
    inputSchema: {
      type: 'object',
      properties: {
        card: cardArgument,
        status: { type: 'string', description: 'A status name, or a kind (todo, doing, done) for the first status of that kind.' },
        place: { type: 'string', description: 'The top or the bottom of the status; bottom when left out.', enum: ['top', 'bottom'] },
        position: { type: 'integer', description: 'A position counted from the top, 1 being first. Wins over place.', minimum: 1 },
        author: authorArgument,
      },
      required: ['card', 'status'],
      additionalProperties: false,
    },
    annotations: writes,
    async run({ boards }, args) {
      const { entry, board, card } = await boards.card(args.card as string);
      if (card.archivedAt !== null) {
        throw new CallerError(`${nameCard(entry.key, card)} is archived. Restore it with archive_card and restore: true, then move it.`);
      }
      const status = resolveStatus(board, args.status as string);
      const place: CardPlace = typeof args.position === 'number' ? args.position - 1 : ((args.place as 'top' | 'bottom' | undefined) ?? 'bottom');
      await boards.access.withDoc(boardDocId(entry.notebookId), (doc) => moveCard(doc, card.id, { statusId: status.id, place }, author(args)));
      return `Moved ${nameCard(entry.key, card)} to ${status.name} (${status.kind}).\n`;
    },
  },
  {
    name: 'add_comment',
    description:
      'Adds a comment to a card. Use it to leave what the next reader needs: a finding, a decision and why, what blocks ' +
      'the task, or, when stopping, what was done, what is left and how to check it. Longer notes go on the card\'s ' +
      'page with append_to_page.',
    inputSchema: {
      type: 'object',
      properties: {
        card: cardArgument,
        body: { type: 'string', description: 'Markdown.' },
        author: authorArgument,
      },
      required: ['card', 'body'],
      additionalProperties: false,
    },
    annotations: writes,
    async run({ boards }, args) {
      const { entry, card } = await boards.card(args.card as string);
      const body = nonEmpty('add_comment', 'a body', args.body);
      await boards.access.withDoc(boardDocId(entry.notebookId), (doc) => addComment(doc, card.id, body, author(args)));
      return `Commented on ${nameCard(entry.key, card)}.\n`;
    },
  },
  {
    name: 'add_link',
    description:
      'Links a card to something outside the board: a branch or pull request, an issue, a document, or a page as ' +
      'looseleaf:<page id>. A card keeps one link per target; linking the same target again only changes its title.',
    inputSchema: {
      type: 'object',
      properties: {
        card: cardArgument,
        target: { type: 'string', description: 'An http(s) address, or looseleaf:<page id> for a page.' },
        title: { type: 'string', description: 'What the link is, in a few words.' },
      },
      required: ['card', 'target', 'title'],
      additionalProperties: false,
    },
    annotations: writes,
    async run({ boards }, args) {
      const { entry, card } = await boards.card(args.card as string);
      const target = linkTarget(args.target as string);
      await boards.access.withDoc(boardDocId(entry.notebookId), (doc) => addLink(doc, card.id, { target, title: (args.title as string).trim() }));
      return `Linked ${nameCard(entry.key, card)} to ${target}.\n`;
    },
  },
  {
    name: 'archive_card',
    description:
      'Archives a card, which takes it off the board and leaves its page where it is, or restores an archived card with ' +
      'its ref and history. Archive only a card the user asked to be rid of; a finished task is moved to a done status ' +
      'instead. No tool deletes a card.',
    inputSchema: {
      type: 'object',
      properties: {
        card: cardArgument,
        restore: { type: 'boolean', description: 'True to bring an archived card back; false when left out.' },
        author: authorArgument,
      },
      required: ['card'],
      additionalProperties: false,
    },
    annotations: writes,
    async run({ boards }, args) {
      const { entry, card } = await boards.card(args.card as string);
      const restore = args.restore === true;
      await boards.access.withDoc(boardDocId(entry.notebookId), (doc) => (restore ? restoreCard(doc, card.id, author(args)) : archiveCard(doc, card.id, author(args))));
      return `${restore ? 'Restored' : 'Archived'} ${nameCard(entry.key, card)}.\n`;
    },
  },
  {
    name: 'create_status',
    description:
      'Adds a status (a column) to a board. Its kind says what it means for the work on its cards, whatever it is ' +
      'called: todo for not started, doing for being worked on or waiting, done for finished.',
    inputSchema: {
      type: 'object',
      properties: {
        board: boardArgument,
        name: { type: 'string', description: 'The status name, such as In review.' },
        kind: { type: 'string', description: 'What the status means for the work.', enum: STATUS_KINDS },
        position: { type: 'integer', description: 'Where it goes among the statuses, 1 being first; last when left out.', minimum: 1 },
      },
      required: ['name', 'kind'],
      additionalProperties: false,
    },
    annotations: writes,
    async run({ boards }, args) {
      const entry = await boards.entry(args.board as string | undefined);
      const name = nonEmpty('create_status', 'a name', args.name);
      const board = await boards.open(entry);
      if (board.statuses.some((status) => status.name.toLowerCase() === name.toLowerCase())) {
        throw new CallerError(`${entry.name} already has a status called "${name}".`);
      }
      const index = typeof args.position === 'number' ? args.position - 1 : undefined;
      await boards.access.withDoc(boardDocId(entry.notebookId), (doc) => createStatus(doc, { name, kind: args.kind as StatusKind, index }));
      const after = await boards.open(entry);
      return `Added the status ${name} to ${entry.name}. Its statuses are now: ${after.statuses.map((status) => status.name).join(' → ')}.\n`;
    },
  },
  {
    name: 'create_label',
    description:
      'Adds a label to a board. Labels say what a card is about across statuses, such as the app or area it touches, ' +
      'and a card can carry several. A label can be tied to a section of the notebook: a new card whose first tied ' +
      'label it is gets its page filed there.',
    inputSchema: {
      type: 'object',
      properties: {
        board: boardArgument,
        name: { type: 'string', description: 'The label name, such as iOS app.' },
        color: { type: 'string', description: 'The label colour; the one used least so far when left out.', enum: LABEL_COLORS },
        section: { type: 'string', description: 'A section of the board\'s notebook to tie the label to: its id, its name, or its path written "Group / Section".' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    annotations: writes,
    async run({ boards }, args) {
      const entry = await boards.entry(args.board as string | undefined);
      const name = nonEmpty('create_label', 'a name', args.name);
      const board = await boards.open(entry);
      if (board.labels.some((existing) => existing.name.toLowerCase() === name.toLowerCase())) {
        throw new CallerError(`${entry.name} already has a label called "${name}".`);
      }
      const section = typeof args.section === 'string' ? await boards.section(entry.notebookId, args.section) : null;
      const label = await boards.access.withDoc(boardDocId(entry.notebookId), (doc) =>
        createLabel(doc, { name, color: args.color as LabelColor | undefined, section: section?.id ?? null }),
      );
      return `Added the ${label.color} label ${label.name} to ${entry.name}${section === null ? '' : `, tied to the section ${section.path}`}.\n`;
    },
  },
  {
    name: 'create_board',
    description:
      'Makes the board of a notebook, with the statuses Backlog, This week, In progress, Blocked and Done, and answers ' +
      'with its key. A notebook has one board at most. Card refs on the board start with the key. Most work belongs ' +
      'on a board that already exists; check list_boards first.',
    inputSchema: {
      type: 'object',
      properties: {
        notebook: { type: 'string', description: 'The notebook: its name or its id from list_notebooks.' },
        key: { type: 'string', description: 'Up to 6 letters and digits that card refs start with, such as WEB. Made from the notebook\'s name when left out.' },
      },
      required: ['notebook'],
      additionalProperties: false,
    },
    annotations: writes,
    async run({ boards }, args) {
      const text = nonEmpty('create_board', 'a notebook', args.notebook);
      const notebooks = await boards.notebooks();
      const named = notebooks.filter((notebook) => notebook.name.toLowerCase() === text.toLowerCase());
      const notebook = notebooks.find((candidate) => candidate.id === text) ?? (named.length === 1 ? named[0] : undefined);
      if (notebook === undefined) {
        throw new CallerError(
          named.length > 1
            ? `Several notebooks are called "${text}". Give the notebook id from list_notebooks.`
            : `No notebook is called "${text}". The notebooks are: ${notebooks.map((candidate) => candidate.name).join(', ') || 'none yet'}.`,
        );
      }
      const takenKeys = await boards.takenKeys();
      const made = await boards.access.withDoc(boardDocId(notebook.id), (doc) => {
        const existing = readBoardMeta(doc);
        if (existing !== null) return { key: existing.key, created: false };
        return { key: createBoard(doc, { notebookId: notebook.id, name: notebook.name, key: args.key as string | undefined, takenKeys }).key, created: true };
      });
      if (!made.created) {
        throw new CallerError(`${notebook.name} already has a board, with the key ${made.key}. A notebook has one board; see it with get_board.`);
      }
      return `Made the board of ${notebook.name} with the key ${made.key} and the statuses Backlog, This week, In progress, Blocked and Done.\n`;
    },
  },
];
