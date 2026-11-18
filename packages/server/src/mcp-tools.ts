/**
 * The MCP endpoint's tools as one list: what `tools/list` describes and what
 * `tools/call` runs. A tool's definition and what it does sit together, in
 * `mcp-notes-tools.ts` (notes), `mcp-board-read-tools.ts` and
 * `mcp-board-write-tools.ts` (boards). This file checks a call's arguments
 * against the tool's schema and turns what the tool answers into a result. A
 * mistake the caller can fix (an unknown id or card, a bad argument) is a
 * result with `isError` set. This file knows nothing about JSON-RPC or HTTP.
 */
import { CallerError, type Boards } from './boards.js';
import { BOARD_READ_TOOLS } from './mcp-board-read-tools.js';
import { BOARD_WRITE_TOOLS } from './mcp-board-write-tools.js';
import { NOTES_TOOLS } from './mcp-notes-tools.js';
import type { MirrorView } from './mirror.js';
import type { NotesWriter } from './notes-writer.js';

/** What the tools read and write. */
export interface McpContext {
  /** The running mirror the notes read tools read, or null when the mirror is off. */
  mirror: MirrorView | null;
  /** What the notes write tools change the docs through. */
  writer: NotesWriter;
  boards: Boards;
  /** The server's address as the caller reached it, e.g. `http://nas:8421`, for page addresses; '' when unknown. */
  baseUrl: string;
}

interface TextProperty {
  type: 'string';
  description: string;
  enum?: readonly string[];
}

interface ObjectItems {
  type: 'object';
  properties: Record<string, TextProperty>;
  required: readonly string[];
  additionalProperties: false;
}

export type McpProperty =
  | TextProperty
  | { type: 'integer'; description: string; minimum?: number; maximum?: number }
  | { type: 'boolean'; description: string }
  | { type: 'array'; description: string; items: { type: 'string' } | ObjectItems };

export interface McpTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, McpProperty>;
    required?: readonly string[];
    additionalProperties: false;
  };
  annotations: { readOnlyHint: boolean };
  /**
   * Does the work on arguments that fit the schema. Answers with the text to
   * show or a whole result; throws CallerError for a mistake the caller can fix.
   */
  run(context: McpContext, args: Record<string, unknown>): Promise<string | McpToolResult>;
}

/** What `tools/call` answers: one text block, flagged when the call could not be done. */
export interface McpToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: true;
}

export const MCP_TOOLS: readonly McpTool[] = [...NOTES_TOOLS, ...BOARD_READ_TOOLS, ...BOARD_WRITE_TOOLS];

/** The tools as `tools/list` sends them. */
export function describeTools(): Array<Omit<McpTool, 'run'>> {
  return MCP_TOOLS.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations }));
}

/** Thrown by `callMcpTool` for a tool name it does not have. */
export class UnknownToolError extends Error {}

/**
 * Runs a tool. `args` is the request's `arguments` as received. Throws
 * UnknownToolError for a name that is not in MCP_TOOLS; any other throw is a
 * server fault.
 */
export async function callMcpTool(context: McpContext, name: string, args: unknown): Promise<McpToolResult> {
  const tool = MCP_TOOLS.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new UnknownToolError(`No tool is named "${name}". The tools are ${MCP_TOOLS.map((t) => t.name).join(', ')}.`);
  const checked = checkArguments(tool, args);
  if (typeof checked === 'string') return failure(checked);
  try {
    const answer = await tool.run(context, checked);
    return typeof answer === 'string' ? success(answer) : answer;
  } catch (error) {
    if (error instanceof CallerError) return failure(error.message);
    throw error;
  }
}

function success(text: string): McpToolResult {
  return { content: [{ type: 'text', text }] };
}

function failure(text: string): McpToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

/** The arguments when they fit the tool's input schema, else a message saying what is wrong. */
function checkArguments(tool: McpTool, args: unknown): Record<string, unknown> | string {
  if (args === undefined || args === null) args = {};
  if (typeof args !== 'object' || Array.isArray(args)) return `The arguments to ${tool.name} must be an object.`;
  const values = args as Record<string, unknown>;
  const { properties, required = [] } = tool.inputSchema;
  for (const key of Object.keys(values)) {
    if (!Object.hasOwn(properties, key)) {
      const known = Object.keys(properties);
      return `${tool.name} has no argument "${key}". ${known.length === 0 ? 'It takes no arguments.' : `Its arguments are ${known.join(', ')}.`}`;
    }
  }
  for (const key of required) {
    if (values[key] === undefined || values[key] === null) return `${tool.name} needs the argument "${key}".`;
  }
  const checked: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null) continue;
    const problem = checkValue(key, value, properties[key]!);
    if (problem !== null) return problem;
    checked[key] = value;
  }
  return checked;
}

function checkValue(key: string, value: unknown, property: McpProperty): string | null {
  switch (property.type) {
    case 'string':
      return checkText(key, value, property);
    case 'integer': {
      if (typeof value !== 'number' || !Number.isInteger(value)) return `"${key}" must be a whole number.`;
      const { minimum, maximum } = property;
      if ((minimum !== undefined && value < minimum) || (maximum !== undefined && value > maximum)) {
        return maximum === undefined ? `"${key}" must be at least ${minimum}.` : `"${key}" must be from ${minimum} to ${maximum}.`;
      }
      return null;
    }
    case 'boolean':
      return typeof value === 'boolean' ? null : `"${key}" must be true or false.`;
    case 'array': {
      if (!Array.isArray(value)) return `"${key}" must be a list.`;
      for (const [index, item] of value.entries()) {
        const problem = property.items.type === 'string' ? checkText(`${key}[${index}]`, item, null) : checkItem(`${key}[${index}]`, item, property.items);
        if (problem !== null) return problem;
      }
      return null;
    }
  }
}

function checkText(key: string, value: unknown, property: TextProperty | null): string | null {
  if (typeof value !== 'string') return `"${key}" must be a string.`;
  if (property?.enum !== undefined && !property.enum.includes(value)) return `"${key}" must be one of: ${property.enum.join(', ')}.`;
  return null;
}

function checkItem(key: string, value: unknown, items: ObjectItems): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return `"${key}" must be an object.`;
  const fields = value as Record<string, unknown>;
  for (const field of Object.keys(fields)) {
    if (!Object.hasOwn(items.properties, field)) return `"${key}" has no field "${field}". Its fields are: ${Object.keys(items.properties).join(', ')}.`;
  }
  for (const field of items.required) {
    if (typeof fields[field] !== 'string') return `"${key}" needs "${field}": ${items.properties[field]!.description}`;
  }
  for (const [field, fieldValue] of Object.entries(fields)) {
    const problem = checkText(`${key}.${field}`, fieldValue, items.properties[field]!);
    if (problem !== null) return problem;
  }
  return null;
}
