/**
 * The Model Context Protocol over streamable HTTP, stateless, answered with
 * plain JSON: reads one JSON-RPC message from a `POST /mcp` body and works
 * out the reply for `initialize`, `ping`, `tools/list` and `tools/call`.
 * There are no sessions and no SSE streams. The token check and writing the
 * reply live in `http.ts`; the tools live in `mcp-tools.ts` and the files it
 * lists. Nothing here imports the MCP SDK.
 */
import type { IncomingMessage } from 'node:http';
import { callMcpTool, describeTools, UnknownToolError, type McpContext } from './mcp-tools.js';

export const MCP_PATH = '/mcp';
/** Newest first. `initialize` answers the client's version when it is listed here, otherwise the first. */
export const MCP_PROTOCOL_VERSIONS: readonly string[] = ['2025-11-25', '2025-06-18', '2025-03-26'];
/** A request body larger than this is refused with 413. */
export const MCP_MAX_BODY_BYTES = 64 * 1024;

/** Sent to every assistant that connects. It is what makes an agent leave notes behind and keep the boards true as it works. */
const INSTRUCTIONS = [
  "These tools read and add to the user's own notes on their Looseleaf server, as Markdown, and keep the kanban boards " +
    'that show what is being worked on, by the user and by AI agents. ' +
    'list_notebooks gives notebook and section ids, list_pages gives the page ids in a section, search_notes finds ' +
    'pages by words in their title or text, and read_page returns one page by its id. create_notebook makes a notebook ' +
    'with its sections, create_page adds a page at the end of a section and append_to_page adds text to the end of a ' +
    'page; none of them changes or removes anything already in the notes. A write shows in the read tools a few ' +
    'seconds after it is made.',
  'Looseleaf is where the notes and context that outlast a task are kept. When your work produces something the user ' +
    'would want to read in a month, such as a plan, what an investigation found, a decision and its reason, or how to ' +
    'test something, write it to a page without being asked. A small fix needs no page.',
  'Find the page first with search_notes. When one exists on the subject, add a dated entry with append_to_page. When ' +
    'none exists, create_page in the section the subject belongs to; list_notebooks shows the sections, which are ' +
    'often named for an app or an area of work. When the task has a card, its notes go on the card\'s page: ' +
    'read_page and append_to_page take the card ref.',
  'Write notes, not status: whether a task is open or done lives in its card\'s status, not in a page title.',
  "A notebook can have a board. A board's statuses are its columns and each has a kind (todo, doing, done) that holds " +
    'whatever the status is called; within a status, a card higher up matters more. A card is a page in the ' +
    "board's notebook: its title is the page title, its text is the page, and its checklist is the page's To Do lines. " +
    'Labels say what a card is about, such as the app it touches.',
  'Before starting a task: find its card with search_cards (the user may give a ref such as DEE-12). When a card ' +
    'exists, read it in full with get_card before doing anything, including its checklist and comments. When none ' +
    'exists, make one with create_card, with a description someone with no other context could pick up. Then ' +
    'move_card it to a status of kind doing.',
  'When the user is planning work rather than starting it: make the card then, without being asked, in a todo ' +
    'status, with what was said in the conversation: what is wanted, why, and what was decided. Search first so a ' +
    'plan for an existing card updates that card instead.',
  'While working: tick the card\'s To Do lines with update_checklist as each is finished, and add_comment when there ' +
    'is something the next reader needs, such as a finding, a decision, or what blocks the task. Link branches, pull ' +
    'requests and issues with add_link.',
  'When you stop: add_comment saying what was done, what is left and how to check it. Move the card to a done status ' +
    'when it is finished; otherwise leave it where it shows the truth.',
  'Something the user rules out of scope or wants later becomes its own card in a todo status, not a silent ' +
    "omission. A To Do line in a board's Inbox (get_board lists them) becomes a card with create_card and the line's id.",
  'Change only the cards your task is about. Archive a card only when the user asks; no tool deletes a card.',
  "When you are a subagent doing one piece of another agent's task, leave the board to the agent that gave you the " +
    'piece: read cards if they help, and change none.',
].join('\n\n');

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

/** What `http.ts` sends back: a status and a JSON body, or no body at all. */
export interface McpReply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

type RequestId = string | number;

/**
 * Reads the body of an authorised `POST /mcp` and answers it. Rejects a body
 * over MCP_MAX_BODY_BYTES (413), one that is not JSON (400, parse error), a
 * batch or a malformed message (400), and an `Mcp-Protocol-Version` header
 * this server does not speak (400). Notifications and client responses get 202.
 */
export async function answerMcp(req: IncomingMessage, context: McpContext, serverVersion: string): Promise<McpReply> {
  const declared = Number(req.headers['content-length'] ?? NaN);
  if (declared > MCP_MAX_BODY_BYTES) return tooLarge();
  const body = await readBody(req);
  if (body === null) return tooLarge();

  const headerVersion = req.headers['mcp-protocol-version'];
  if (typeof headerVersion === 'string' && !MCP_PROTOCOL_VERSIONS.includes(headerVersion)) {
    return errorReply(400, null, INVALID_REQUEST, `Unsupported Mcp-Protocol-Version ${headerVersion}; this server speaks ${MCP_PROTOCOL_VERSIONS.join(', ')}`);
  }

  let message: unknown;
  try {
    message = JSON.parse(body);
  } catch {
    return errorReply(400, null, PARSE_ERROR, 'Parse error: the request body is not JSON');
  }
  if (Array.isArray(message)) return errorReply(400, null, INVALID_REQUEST, 'Invalid request: send one JSON-RPC message per request, not a batch');
  if (!isRecord(message) || message.jsonrpc !== '2.0') {
    return errorReply(400, null, INVALID_REQUEST, 'Invalid request: the body must be one JSON-RPC 2.0 message');
  }
  const id = message.id;
  const isResponse = !('method' in message) && ('result' in message || 'error' in message);
  if (isResponse) return { status: 202, body: null };
  if (typeof message.method !== 'string') return errorReply(400, null, INVALID_REQUEST, 'Invalid request: "method" must be a string');
  if (id === undefined) return { status: 202, body: null };
  if (typeof id !== 'string' && typeof id !== 'number') {
    return errorReply(400, null, INVALID_REQUEST, 'Invalid request: "id" must be a string or a number');
  }
  return answerRequest(id, message.method, message.params, context, serverVersion);
}

async function answerRequest(id: RequestId, method: string, params: unknown, context: McpContext, serverVersion: string): Promise<McpReply> {
  switch (method) {
    case 'initialize': {
      const asked = isRecord(params) ? params.protocolVersion : undefined;
      const protocolVersion = typeof asked === 'string' && MCP_PROTOCOL_VERSIONS.includes(asked) ? asked : MCP_PROTOCOL_VERSIONS[0];
      return result(id, {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'looseleaf', version: serverVersion },
        instructions: INSTRUCTIONS,
      });
    }
    case 'ping':
      return result(id, {});
    case 'tools/list':
      return result(id, { tools: describeTools() });
    case 'tools/call': {
      const name = isRecord(params) ? params.name : undefined;
      if (typeof name !== 'string') return errorReply(200, id, INVALID_PARAMS, 'tools/call needs params.name, the tool to call');
      try {
        return result(id, await callMcpTool(context, name, (params as Record<string, unknown>).arguments));
      } catch (error) {
        if (error instanceof UnknownToolError) return errorReply(200, id, INVALID_PARAMS, error.message);
        console.error(`MCP tool ${name} failed`, error);
        return errorReply(200, id, INTERNAL_ERROR, `The tool ${name} failed on the server: ${(error as Error).message}`);
      }
    }
    default:
      return errorReply(200, id, METHOD_NOT_FOUND, `Method not found: ${method}`);
  }
}

/** The body as text, or null once it passes MCP_MAX_BODY_BYTES. */
async function readBody(req: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MCP_MAX_BODY_BYTES) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function tooLarge(): McpReply {
  // Closing the connection stops the rest of a large body arriving.
  return { ...errorReply(413, null, INVALID_REQUEST, `The request body is larger than ${MCP_MAX_BODY_BYTES} bytes`), headers: { Connection: 'close' } };
}

function result(id: RequestId, value: unknown): McpReply {
  return { status: 200, body: { jsonrpc: '2.0', id, result: value } };
}

function errorReply(status: number, id: RequestId | null, code: number, message: string): McpReply {
  return { status, body: { jsonrpc: '2.0', id, error: { code, message } } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
