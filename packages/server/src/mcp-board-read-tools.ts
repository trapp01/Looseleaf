/**
 * The MCP board tools that only read: the boards, one board at a glance with
 * its Inbox, a search for cards, and one card in full with its page. They
 * read docs through `Boards`, never the mirror, so they answer with what was
 * stored a moment ago and work with the mirror off.
 */
import { cardsInStatus, findStatus, renderBoard, renderCard, renderCardLine, searchCards, shownStatusId } from '@looseleaf/model';
import { dueDay, resolveLabel, resolveStatus } from './boards.js';
import type { McpProperty, McpTool } from './mcp-tools.js';

export const CARD_SEARCH_DEFAULT_LIMIT = 25;
export const CARD_SEARCH_MAX_LIMIT = 100;

export const boardArgument: McpProperty = {
  type: 'string',
  description: 'A board key such as DEE, or the name of the board\'s notebook. Can be left out when there is only one board.',
};

export const cardArgument: McpProperty = {
  type: 'string',
  description: 'A card ref such as DEE-12, or the card\'s page id or page address.',
};

export const BOARD_READ_TOOLS: readonly McpTool[] = [
  {
    name: 'list_boards',
    description:
      'Lists every board with its key, its notebook, its statuses in order (each with its kind, todo, doing or done, and ' +
      'its number of cards) and its labels. A notebook has one board or none. Start here when you do not know the board.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    async run({ boards }) {
      const entries = await boards.list();
      if (entries.length === 0) return 'There are no boards yet. Make one on a notebook with create_board.';
      const sections: string[] = [];
      for (const entry of entries) {
        const board = await boards.open(entry);
        const statuses = board.statuses.map((status) => `${status.name} (${status.kind}, ${cardsInStatus(board, status.id).length})`);
        sections.push(
          [
            `## ${entry.name} (${entry.key})`,
            `Notebook id: ${entry.notebookId}`,
            `Statuses: ${statuses.join(' → ') || 'none yet'}`,
            `Labels: ${board.labels.map((label) => label.name).join(', ') || 'none yet'}`,
          ].join('\n'),
        );
      }
      return sections.join('\n\n') + '\n';
    },
  },
  {
    name: 'get_board',
    description:
      'Shows one board at a glance. First the Inbox: To Do lines tagged anywhere in the notebook since the board was ' +
      'made, newest first, each with the page it is on and its line id; create_card with a line id turns one into a ' +
      'card. Then every status in order with its cards, top first; a card higher in a status matters more. Each card ' +
      'line has its ref (such as DEE-12), title, labels, due day, checklist progress and comment count. Narrow it to ' +
      'one status or one label to see less; the Inbox is left out then.',
    inputSchema: {
      type: 'object',
      properties: {
        board: boardArgument,
        status: { type: 'string', description: 'Only this status: its name, or a kind (todo, doing, done) for the first status of that kind.' },
        label: { type: 'string', description: 'Only cards carrying this label, by name.' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    async run({ boards, baseUrl }, args) {
      const entry = await boards.entry(args.board as string | undefined);
      const board = await boards.open(entry);
      let shown = board;
      if (typeof args.label === 'string') {
        const label = resolveLabel(board, args.label);
        shown = { ...shown, cards: shown.cards.filter((card) => card.labelIds.includes(label.id)) };
      }
      if (typeof args.status === 'string') {
        const status = resolveStatus(board, args.status);
        // Narrow the cards too: a card whose status is not listed would otherwise show under the first one that is.
        shown = { ...shown, statuses: [status], cards: shown.cards.filter((card) => shownStatusId(board, card) === status.id) };
      }
      const narrowed = shown !== board;
      return renderBoard(shown, {
        name: entry.name,
        baseUrl,
        checklists: await boards.checklists(shown.cards.map((card) => card.id)),
        inbox: narrowed ? undefined : await boards.inbox(entry, board),
      });
    },
  },
  {
    name: 'search_cards',
    description:
      'Finds cards by words and filters, across every board unless one is named. The query is split into words; a card ' +
      'matches when every word appears in its title, its page, its labels, comments or links. Title matches come first. ' +
      'With no query, the most recently changed cards come first. Each result shows the card line and its status. Use ' +
      'get_card on a result to read it in full.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words to find, separated by spaces.' },
        board: { type: 'string', description: 'Only this board: its key or its notebook\'s name.' },
        status: { type: 'string', description: 'Only this status: its name, or a kind (todo, doing, done) for every status of that kind.' },
        label: { type: 'string', description: 'Only cards carrying this label, by name.' },
        due_by: { type: 'string', description: 'Only cards due on or before this day, as YYYY-MM-DD.' },
        include_archived: { type: 'boolean', description: 'Also search archived cards; false when left out.' },
        limit: { type: 'integer', description: `Most results to return; ${CARD_SEARCH_DEFAULT_LIMIT} when left out.`, minimum: 1, maximum: CARD_SEARCH_MAX_LIMIT },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    async run({ boards }, args) {
      const entries = typeof args.board === 'string' ? [await boards.entry(args.board)] : await boards.list();
      const limit = (args.limit as number | undefined) ?? CARD_SEARCH_DEFAULT_LIMIT;
      const dueBy = typeof args.due_by === 'string' ? (dueDay(args.due_by) ?? undefined) : undefined;
      const query = typeof args.query === 'string' ? args.query : undefined;
      const statusText = typeof args.status === 'string' ? args.status.trim().toLowerCase() : null;
      const labelText = typeof args.label === 'string' ? args.label.trim().toLowerCase() : null;
      const lines: string[] = [];
      let total = 0;
      for (const entry of entries) {
        const board = await boards.open(entry);
        const label = labelText === null ? null : board.labels.find((candidate) => candidate.name.toLowerCase() === labelText);
        if (label === undefined) continue;
        const statusIds =
          statusText === null
            ? null
            : board.statuses.filter((status) => status.name.toLowerCase() === statusText || status.kind === statusText).map((status) => status.id);
        // Page text is only read when there are words to find in it.
        const pageText = query === undefined || query.trim() === '' ? undefined : await boards.pageTexts(board.cards.map((card) => card.id));
        const found = searchCards(board, { query, labelId: label?.id, dueBy, includeArchived: args.include_archived === true }, pageText).filter(
          (card) => statusIds === null || statusIds.includes(card.statusId),
        );
        total += found.length;
        const checklists = await boards.checklists(found.slice(0, limit).map((card) => card.id));
        for (const card of found) {
          if (lines.length >= limit) break;
          const status = findStatus(board, card.statusId);
          const hidden = card.archivedAt !== null || shownStatusId(board, card) === null ? ' (archived)' : '';
          lines.push(`- ${renderCardLine(board, card, checklists.get(card.id))} — ${status?.name ?? 'no status'}${hidden}`);
        }
      }
      if (total === 0) return 'No cards match. Try fewer words, or list_boards to check the status and label names.';
      const heading = total > lines.length ? `Showing ${lines.length} of ${total} matching cards.` : `${total} matching card${total === 1 ? '' : 's'}.`;
      return `${heading}\n\n${lines.join('\n')}\n`;
    },
  },
  {
    name: 'get_card',
    description:
      'Returns everything on one card as Markdown: its status and position, labels, due day, its page, its checklist ' +
      '(the To Do lines on the page, each with its line id), links, comments and activity. Read this before working on ' +
      'a card. A card is a page: the Id line is the page id, which never changes and which every tool takes in place ' +
      'of the ref.',
    inputSchema: {
      type: 'object',
      properties: { card: cardArgument },
      required: ['card'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    async run({ boards, baseUrl }, args) {
      const { entry, board, card } = await boards.card(args.card as string);
      const page = await boards.pageMarkdown(entry.notebookId, card.id);
      const checklists = new Map([[card.id, await boards.todoLines(card.id)]]);
      return renderCard(board, card, { name: entry.name, baseUrl, page, checklists });
    },
  },
];

