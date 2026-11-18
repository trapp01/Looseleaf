/**
 * The Model Context Protocol over streamable HTTP, stateless, answered with
 * plain JSON: reads one JSON-RPC message from a `POST /mcp` body and works
 * out the reply for `initialize`, `ping`, `tools/list` and `tools/call`.
 * There are no sessions and no SSE streams. The token check, the mirror-off
 * answer and writing the reply live in `http.ts`; what the tools read and
 * write lives in `mcp-tools.ts`. Nothing here imports the MCP SDK.
 */
import type { IncomingMessage } from 'node:http';
import { callMcpTool, MCP_TOOLS, UnknownToolError, type McpNotes } from './mcp-tools.js';

export const MCP_PATH = '/mcp';
/** Newest first. `initialize` answers the client's version when it is listed here, otherwise the first. */
export const MCP_PROTOCOL_VERSIONS: readonly string[] = ['2025-11-25', '2025-06-18', '2025-03-26'];
/** A request body larger than this is refused with 413. */
export const MCP_MAX_BODY_BYTES = 64 * 1024;

/** Sent to every assistant that connects. It is what makes an agent leave notes behind as it works. */
const INSTRUCTIONS = [
  "These tools read and add to the user's own notes on their Looseleaf server, as Markdown. " +
    'list_notebooks gives notebook and section ids, list_pages gives the page ids in a section, search_notes finds ' +
    'pages by words in their title or text, and read_page returns one page by its id. create_page adds a page at the ' +
    'end of a section and append_to_page adds text to the end of a page; neither changes or removes anything already ' +
    'in the notes. A write shows in the read tools a few seconds after it is made.',
  'Looseleaf is where the notes and context that outlast a task are kept. When your work produces something the user ' +
    'would want to read in a month, such as a plan, what an investigation found, a decision and its reason, or how to ' +
    'test something, write it to a page without being asked. A small fix needs no page.',
  'Find the page first with search_notes. When one exists on the subject, add a dated entry with append_to_page. When ' +
    'none exists, create_page in the section the subject belongs to; list_notebooks shows the sections, which are ' +
    'often named for an app or an area of work.',
  'Write notes, not status: whether a task is open or done lives on the task board, not in a page title or a ' +
    'checklist here.',
  "When the task has a card on Corkboard, the user's kanban board, start a new page with the card's address, and link " +
    'the page from the card as looseleaf:<page id>.',
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
export async function answerMcp(req: IncomingMessage, notes: McpNotes, serverVersion: string): Promise<McpReply> {
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
  return answerRequest(id, message.method, message.params, notes, serverVersion);
}

async function answerRequest(id: RequestId, method: string, params: unknown, notes: McpNotes, serverVersion: string): Promise<McpReply> {
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
      return result(id, { tools: MCP_TOOLS });
    case 'tools/call': {
      const name = isRecord(params) ? params.name : undefined;
      if (typeof name !== 'string') return errorReply(200, id, INVALID_PARAMS, 'tools/call needs params.name, the tool to call');
      try {
        return result(id, await callMcpTool(notes, name, (params as Record<string, unknown>).arguments));
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
