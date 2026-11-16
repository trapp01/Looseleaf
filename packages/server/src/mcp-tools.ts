/**
 * The MCP endpoint's tools: their definitions, their argument checks and what
 * each one answers. The read tools read a running mirror: pages, their order
 * and ids come from the mirror manifest, and text comes from the mirror's page
 * files, read through `MirrorView.readText`. The write tools (create_page,
 * append_to_page) change the docs through `NotesWriter`, and the mirror shows
 * the change after its delay. A mistake the caller can fix (an unknown id, a
 * bad argument) is a result with `isError` set. This file knows nothing about
 * JSON-RPC or HTTP.
 */
import type { MirrorManifest, MirrorPage } from '@looseleaf/model';
import type { MirrorView } from './mirror.js';
import type { NotesWriter, WriteOutcome } from './notes-writer.js';

export const SEARCH_DEFAULT_LIMIT = 20;
export const SEARCH_MAX_LIMIT = 100;
/** Matching lines shown per search result. */
const SNIPPETS_PER_PAGE = 3;
const SNIPPET_CHARS = 200;

/** A tool as `tools/list` describes it. */
export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, JsonSchemaProperty>;
    required?: string[];
    additionalProperties: false;
  };
  annotations: { readOnlyHint: boolean };
}

/** What the tools read and write: the running mirror, and the writer that changes the docs. */
export interface McpNotes {
  mirror: MirrorView;
  writer: NotesWriter;
}

interface JsonSchemaProperty {
  type: 'string' | 'integer';
  description: string;
  minimum?: number;
  maximum?: number;
}

/** What `tools/call` answers: one text block, flagged when the call could not be done. */
export interface McpToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: true;
}

const readOnly = { readOnlyHint: true };
const writes = { readOnlyHint: false };

const MARKDOWN_HELP =
  'Markdown supported: paragraphs, # headings 1-6, - and 1. lists (nested by indenting), - [ ] and - [x] to-do items, ' +
  '**bold**, *italic*, ~~strike~~, [links](https://…), > quotes, ``` fenced code and | pipe | tables. A single line ' +
  'break inside a paragraph is a space; end the line with two spaces or a backslash, or write <br>, for a line break. ' +
  'Inline `code` keeps its text without the backticks. Pictures cannot be added.';

export const MCP_TOOLS: readonly McpToolDefinition[] = [
  {
    name: 'list_notebooks',
    description:
      'Lists every notebook with its sections, in notebook order. Each notebook shows its id; each section shows its path ' +
      '(a section inside section groups is written "Group / Section"), its id and its number of pages. Notebooks and ' +
      'sections with no pages are not listed.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: readOnly,
  },
  {
    name: 'list_pages',
    description:
      'Lists the pages of one section in order, each with its title, its id and its subpage level (0 for a top page, ' +
      '1 or 2 for a subpage). Subpages are indented under the page above them.',
    inputSchema: {
      type: 'object',
      properties: { section_id: { type: 'string', description: 'A section id from list_notebooks.' } },
      required: ['section_id'],
      additionalProperties: false,
    },
    annotations: readOnly,
  },
  {
    name: 'search_notes',
    description:
      'Searches page titles and page text, ignoring case. The query is split into words; a page matches when every word ' +
      'appears in its title or its text. Pages with every word in the title come first, then pages with more ' +
      'occurrences. Each result shows the page id, title, notebook, section and up to 3 matching lines.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words to find, separated by spaces.' },
        notebook_id: { type: 'string', description: 'Only search this notebook (an id from list_notebooks).' },
        limit: {
          type: 'integer',
          description: `Most results to return; ${SEARCH_DEFAULT_LIMIT} when left out.`,
          minimum: 1,
          maximum: SEARCH_MAX_LIMIT,
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
    annotations: readOnly,
  },
  {
    name: 'read_page',
    description:
      'Returns one page as Markdown: a front matter block with the page id, notebook and section, then the title, the ' +
      'created time and the page text. Pictures and attached files appear as Markdown links to files in the mirror, ' +
      'not as their contents.',
    inputSchema: {
      type: 'object',
      properties: { page_id: { type: 'string', description: 'A page id from list_pages or search_notes.' } },
      required: ['page_id'],
      additionalProperties: false,
    },
    annotations: readOnly,
  },
  {
    name: 'create_page',
    description:
      'Creates a new page at the end of a section, with a title and optional Markdown text, and answers with its page ' +
      'id. The new page shows in read_page, list_pages and search_notes a few seconds later. ' +
      MARKDOWN_HELP,
    inputSchema: {
      type: 'object',
      properties: {
        section_id: { type: 'string', description: 'A section id from list_notebooks.' },
        title: { type: 'string', description: 'The page title.' },
        markdown: { type: 'string', description: 'The page text as Markdown. Leave it out for an empty page.' },
      },
      required: ['section_id', 'title'],
      additionalProperties: false,
    },
    annotations: writes,
  },
  {
    name: 'append_to_page',
    description:
      'Adds Markdown text to the end of a page, after everything already on it; nothing already on the page is changed ' +
      'or moved. The text shows in read_page and search_notes a few seconds later. ' +
      MARKDOWN_HELP,
    inputSchema: {
      type: 'object',
      properties: {
        page_id: { type: 'string', description: 'A page id from list_pages, search_notes or create_page.' },
        markdown: { type: 'string', description: 'The text to add, as Markdown.' },
      },
      required: ['page_id', 'markdown'],
      additionalProperties: false,
    },
    annotations: writes,
  },
];

/** Thrown by `callMcpTool` for a tool name it does not have. */
export class UnknownToolError extends Error {}

/**
 * Runs a tool: a read tool against the mirror's current state, a write tool
 * through the writer. `args` is the request's `arguments` as received. Throws
 * UnknownToolError for a name that is not in MCP_TOOLS; any other throw is a
 * server fault.
 */
export async function callMcpTool(notes: McpNotes, name: string, args: unknown): Promise<McpToolResult> {
  const tool = MCP_TOOLS.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new UnknownToolError(`No tool is named "${name}". The tools are ${MCP_TOOLS.map((t) => t.name).join(', ')}.`);
  const checked = checkArguments(tool, args);
  if (typeof checked === 'string') return failure(checked);
  if (tool.name === 'create_page') {
    const title = (checked.title as string).replace(/\s*[\r\n]+\s*/g, ' ').trim();
    if (title === '') return failure('The title is empty. Give the page a title.');
    const markdown = checked.markdown as string | undefined;
    const outcome = await notes.writer.createPage({
      sectionId: checked.section_id as string,
      title,
      markdown: markdown === undefined || markdown.trim() === '' ? undefined : markdown,
    });
    return answerWrite('create', outcome, checked.section_id as string);
  }
  if (tool.name === 'append_to_page') {
    const markdown = checked.markdown as string;
    if (markdown.trim() === '') return failure('The markdown is empty. Give the text to add to the page.');
    return answerWrite('append', await notes.writer.appendToPage({ pageId: checked.page_id as string, markdown }), checked.page_id as string);
  }
  const { mirror } = notes;
  const manifest = mirror.manifest;
  if (manifest === null) return failure('The mirror of the notes is still being built. Try again in a few seconds.');
  switch (tool.name) {
    case 'list_notebooks':
      return listNotebooks(manifest);
    case 'list_pages':
      return listPages(manifest, checked.section_id as string);
    case 'search_notes':
      return searchNotes(mirror, manifest, {
        query: checked.query as string,
        notebookId: checked.notebook_id as string | undefined,
        limit: (checked.limit as number | undefined) ?? SEARCH_DEFAULT_LIMIT,
      });
    case 'read_page':
      return readPage(mirror, manifest, checked.page_id as string);
    default:
      throw new Error(`Tool ${tool.name} is defined but has no implementation`);
  }
}

/** The arguments when they fit the tool's input schema, else a message saying what is wrong. */
function checkArguments(tool: McpToolDefinition, args: unknown): Record<string, unknown> | string {
  if (args === undefined || args === null) args = {};
  if (typeof args !== 'object' || Array.isArray(args)) return `The arguments to ${tool.name} must be an object.`;
  const values = args as Record<string, unknown>;
  const { properties, required = [] } = tool.inputSchema;
  for (const key of Object.keys(values)) {
    if (!(key in properties)) {
      const known = Object.keys(properties);
      return `${tool.name} has no argument "${key}". ${known.length === 0 ? 'It takes no arguments.' : `Its arguments are ${known.join(', ')}.`}`;
    }
  }
  for (const key of required) {
    if (values[key] === undefined) return `${tool.name} needs the argument "${key}".`;
  }
  for (const [key, value] of Object.entries(values)) {
    const property = properties[key]!;
    if (property.type === 'string' && typeof value !== 'string') return `"${key}" must be a string.`;
    if (property.type === 'integer') {
      if (typeof value !== 'number' || !Number.isInteger(value)) return `"${key}" must be a whole number.`;
      if ((property.minimum !== undefined && value < property.minimum) || (property.maximum !== undefined && value > property.maximum)) {
        return `"${key}" must be from ${property.minimum} to ${property.maximum}.`;
      }
    }
  }
  return values;
}

function listNotebooks(manifest: MirrorManifest): McpToolResult {
  if (manifest.pages.length === 0) return success('The library has no pages yet.');
  const lines: string[] = [];
  let notebookId: string | null = null;
  for (const section of sectionsOf(manifest.pages)) {
    if (section.first.notebookId !== notebookId) {
      notebookId = section.first.notebookId;
      if (lines.length > 0) lines.push('');
      lines.push(`${section.first.notebook} (notebook id: ${notebookId})`);
    }
    lines.push(`  ${sectionPath(section.first)} (section id: ${section.first.sectionId}, ${count(section.pages.length, 'page')})`);
  }
  return success(lines.join('\n'));
}

/** Pages grouped by section, in the order each section first appears. */
function sectionsOf(pages: MirrorPage[]): Array<{ first: MirrorPage; pages: MirrorPage[] }> {
  const sections = new Map<string, { first: MirrorPage; pages: MirrorPage[] }>();
  for (const page of pages) {
    const key = `${page.notebookId}\n${page.sectionId}`;
    const section = sections.get(key);
    if (section === undefined) sections.set(key, { first: page, pages: [page] });
    else section.pages.push(page);
  }
  return [...sections.values()];
}

function listPages(manifest: MirrorManifest, sectionId: string): McpToolResult {
  const pages = manifest.pages.filter((page) => page.sectionId === sectionId);
  const first = pages[0];
  if (first === undefined) return failure(`No section with pages has the id "${sectionId}". Call list_notebooks to see the section ids.`);
  const lines = [`Section ${sectionPath(first)} (section id: ${sectionId}) in notebook ${first.notebook}, ${count(pages.length, 'page')}:`];
  for (const page of pages) lines.push(`${'  '.repeat(page.level)}- ${titleOf(page)} (page id: ${page.id}, level ${page.level})`);
  return success(lines.join('\n'));
}

interface SearchHit {
  page: MirrorPage;
  order: number;
  allInTitle: boolean;
  occurrences: number;
  snippets: string[];
}

async function searchNotes(
  mirror: MirrorView,
  manifest: MirrorManifest,
  input: { query: string; notebookId: string | undefined; limit: number },
): Promise<McpToolResult> {
  const words = input.query.toLowerCase().split(/\s+/).filter((word) => word !== '');
  if (words.length === 0) return failure('The query is empty. Give one or more words to search for.');
  let pages = manifest.pages;
  if (input.notebookId !== undefined) {
    pages = pages.filter((page) => page.notebookId === input.notebookId);
    if (pages.length === 0) return failure(`No notebook with pages has the id "${input.notebookId}". Call list_notebooks to see the notebook ids.`);
  }
  const texts = await Promise.all(pages.map((page) => mirror.readText(page.path)));
  const hits: SearchHit[] = [];
  pages.forEach((page, order) => {
    const text = texts[order];
    // A page whose file is missing is being renamed or rewritten; it is searched again on the next call.
    if (text === null || text === undefined) return;
    const hit = matchPage(page, order, withoutFrontMatter(text), words);
    if (hit !== null) hits.push(hit);
  });
  hits.sort((a, b) => Number(b.allInTitle) - Number(a.allInTitle) || b.occurrences - a.occurrences || a.order - b.order);

  const quoted = JSON.stringify(input.query.trim());
  if (hits.length === 0) return success(`No pages match ${quoted}.`);
  const shown = hits.slice(0, input.limit);
  const lines = [
    shown.length < hits.length
      ? `${hits.length} pages match ${quoted}; showing the first ${shown.length}. Narrow the query, pass notebook_id, or raise limit (up to ${SEARCH_MAX_LIMIT}) to see more.`
      : `${count(hits.length, 'page')} ${hits.length === 1 ? 'matches' : 'match'} ${quoted}.`,
  ];
  shown.forEach((hit, index) => {
    lines.push('', `${index + 1}. ${titleOf(hit.page)} (page id: ${hit.page.id})`, `   Notebook: ${hit.page.notebook}. Section: ${sectionPath(hit.page)}`);
    for (const snippet of hit.snippets) lines.push(`   > ${snippet}`);
  });
  return success(lines.join('\n'));
}

function matchPage(page: MirrorPage, order: number, body: string, words: string[]): SearchHit | null {
  const title = page.title.toLowerCase();
  const lowerBody = body.toLowerCase();
  let occurrences = 0;
  let allInTitle = true;
  for (const word of words) {
    const inBody = occurrencesOf(lowerBody, word);
    const inTitle = title.includes(word);
    if (inBody === 0 && !inTitle) return null;
    allInTitle &&= inTitle;
    occurrences += inBody;
  }
  return { page, order, allInTitle, occurrences, snippets: snippetsOf(body, words) };
}

function occurrencesOf(text: string, word: string): number {
  let found = 0;
  for (let at = text.indexOf(word); at !== -1; at = text.indexOf(word, at + word.length)) found += 1;
  return found;
}

/** Up to SNIPPETS_PER_PAGE lines that hold a query word, each cut to about SNIPPET_CHARS around the first one. */
function snippetsOf(body: string, words: string[]): string[] {
  const snippets: string[] = [];
  const lines = body.split('\n');
  // The first line is the page's `# Title` heading, which the result already shows.
  for (const raw of lines.slice(lines[0]?.startsWith('# ') ? 1 : 0)) {
    const line = raw.trim();
    const lower = line.toLowerCase();
    const at = Math.min(...words.map((word) => lower.indexOf(word)).filter((index) => index !== -1));
    if (!Number.isFinite(at)) continue;
    snippets.push(cutAround(line, at));
    if (snippets.length === SNIPPETS_PER_PAGE) break;
  }
  return snippets;
}

function cutAround(line: string, at: number): string {
  if (line.length <= SNIPPET_CHARS) return line;
  const start = Math.max(0, Math.min(at - Math.floor(SNIPPET_CHARS / 3), line.length - SNIPPET_CHARS));
  const end = start + SNIPPET_CHARS;
  return `${start > 0 ? '…' : ''}${line.slice(start, end).trim()}${end < line.length ? '…' : ''}`;
}

/** The page text after the mirror's front matter block. Values in it are JSON-quoted, so none holds a line break. */
function withoutFrontMatter(text: string): string {
  if (!text.startsWith('---\n')) return text;
  const end = text.indexOf('\n---\n', 3);
  return end === -1 ? text : text.slice(end + '\n---\n'.length).replace(/^\n/, '');
}

async function readPage(mirror: MirrorView, manifest: MirrorManifest, pageId: string): Promise<McpToolResult> {
  const page = manifest.pages.find((candidate) => candidate.id === pageId);
  if (page === undefined) return failure(`No page has the id "${pageId}". Call search_notes or list_pages to find page ids.`);
  const text = await mirror.readText(page.path);
  if (text === null) return failure(`The page "${titleOf(page)}" is being rewritten in the mirror. Try again in a few seconds.`);
  return success(text);
}

/** The answer to a write. `id` is the section id (create) or page id (append) the caller gave. */
function answerWrite(action: 'create' | 'append', outcome: WriteOutcome, id: string): McpToolResult {
  switch (outcome.kind) {
    case 'no-section':
      return failure(`No section has the id "${id}". Call list_notebooks to see the section ids.`);
    case 'section-deleted':
      return failure(`The section with the id "${id}" is in Deleted notes. Pick another section from list_notebooks.`);
    case 'no-page':
      return failure(`No page has the id "${id}". Call search_notes or list_pages to find page ids.`);
    case 'page-deleted':
      return failure(`The page with the id "${id}" is in Deleted notes. Add to another page, or make a new one with create_page.`);
    case 'written': {
      const { page, warnings } = outcome;
      const where = `section ${page.section.path.join(' / ')} (section id: ${page.section.id}) in notebook ${page.notebook.name}`;
      const lines = [
        action === 'append'
          ? `Added the text to the end of "${page.title || 'Untitled page'}" (page id: ${page.id}) in ${where}.`
          : `Created the page "${page.title}" (page id: ${page.id}) at the end of ${where}.`,
        'read_page and search_notes show it in a few seconds.',
      ];
      for (const warning of warnings) lines.push(`Note: ${warning}.`);
      return success(lines.join('\n'));
    }
  }
}

function sectionPath(page: MirrorPage): string {
  return page.section.join(' / ');
}

function titleOf(page: MirrorPage): string {
  return page.title === '' ? 'Untitled page' : page.title;
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

function success(text: string): McpToolResult {
  return { content: [{ type: 'text', text }] };
}

function failure(text: string): McpToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}
