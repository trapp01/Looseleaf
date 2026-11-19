/**
 * The MCP notes tools. The read tools read a running mirror: pages, their
 * order and ids come from the mirror manifest, and text comes from the
 * mirror's page files, read through `MirrorView.readText`. With the mirror
 * off they answer that they need it. The write tools (create_notebook,
 * create_page, append_to_page) change the docs through `NotesWriter`, and the mirror shows
 * the change after its delay. `read_page` and `append_to_page` also take a
 * card ref, which `Boards` turns into the card's page id.
 */
import type { MirrorManifest, MirrorPage } from '@looseleaf/model';
import type { MirrorView } from './mirror.js';
import type { McpContext, McpTool, McpToolResult } from './mcp-tools.js';
import type { WriteOutcome } from './notes-writer.js';

export const SEARCH_DEFAULT_LIMIT = 20;
export const SEARCH_MAX_LIMIT = 100;
/** Matching lines shown per search result. */
const SNIPPETS_PER_PAGE = 3;
const SNIPPET_CHARS = 200;

const readOnly = { readOnlyHint: true };
const writes = { readOnlyHint: false };

const MARKDOWN_HELP =
  'Markdown supported: paragraphs, # headings 1-6, - and 1. lists (nested by indenting), - [ ] and - [x] to-do items, ' +
  '**bold**, *italic*, ~~strike~~, [links](https://…), > quotes, ``` fenced code and | pipe | tables. A single line ' +
  'break inside a paragraph is a space; end the line with two spaces or a backslash, or write <br>, for a line break. ' +
  'Inline `code` keeps its text without the backticks. Pictures cannot be added.';

export const NOTES_TOOLS: readonly McpTool[] = [
  {
    name: 'list_notebooks',
    description:
      'Lists every notebook with its sections, in notebook order. Each notebook shows its id; each section shows its path ' +
      '(a section inside section groups is written "Group / Section"), its id and its number of pages. Notebooks and ' +
      'sections with no pages are not listed.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: readOnly,
    async run(context) {
      const manifest = mirrorManifest(context);
      return typeof manifest === 'string' ? failure(manifest) : listNotebooks(manifest);
    },
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
    async run(context, args) {
      const manifest = mirrorManifest(context);
      return typeof manifest === 'string' ? failure(manifest) : listPages(manifest, args.section_id as string);
    },
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
    async run(context, args) {
      const manifest = mirrorManifest(context);
      if (typeof manifest === 'string') return failure(manifest);
      return searchNotes(context.mirror!, manifest, {
        query: args.query as string,
        notebookId: args.notebook_id as string | undefined,
        limit: (args.limit as number | undefined) ?? SEARCH_DEFAULT_LIMIT,
      });
    },
  },
  {
    name: 'read_page',
    description:
      'Returns one page as Markdown: a front matter block with the page id, notebook and section, then the title, the ' +
      'created time and the page text. Pictures and attached files appear as Markdown links to files in the mirror, ' +
      'not as their contents.',
    inputSchema: {
      type: 'object',
      properties: { page_id: { type: 'string', description: 'A page id from list_pages or search_notes, a page address, or a card ref such as DEE-12.' } },
      required: ['page_id'],
      additionalProperties: false,
    },
    annotations: readOnly,
    async run(context, args) {
      const manifest = mirrorManifest(context);
      if (typeof manifest === 'string') return failure(manifest);
      return readPage(context.mirror!, manifest, await pageIdFor(context, args.page_id as string));
    },
  },
  {
    name: 'create_notebook',
    description:
      'Creates a notebook at the end of the library, with top-level sections of the given names in order, and answers ' +
      'with the notebook id and each section id. list_notebooks leaves out a notebook until it has a page, so keep the ' +
      'ids from the answer. A name another notebook already has is refused.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The notebook name.' },
        sections: { type: 'array', items: { type: 'string' }, description: 'Names of sections to make in it, in order. None when left out.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    annotations: writes,
    async run({ writer }, args) {
      const name = oneLine(args.name as string);
      if (name === '') return failure('The name is empty. Give the notebook a name.');
      const sections = ((args.sections as string[] | undefined) ?? []).map(oneLine);
      if (sections.some((section) => section === '')) return failure('A section name is empty. Give every section a name.');
      const outcome = await writer.createNotebook({ name, sections });
      if (outcome.kind === 'name-taken') {
        return failure(`A notebook called "${outcome.name}" already exists. Use it, or pick another name.`);
      }
      const lines = [`Created the notebook ${outcome.notebook.name} (notebook id: ${outcome.notebook.id}).`];
      if (outcome.sections.length === 0) lines.push('It has no sections yet; a board made on it files cards in its Unfiled section.');
      for (const section of outcome.sections) lines.push(`  ${section.name} (section id: ${section.id})`);
      return success(lines.join('\n'));
    },
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
    async run({ writer }, args) {
      const title = oneLine(args.title as string);
      if (title === '') return failure('The title is empty. Give the page a title.');
      const markdown = args.markdown as string | undefined;
      const outcome = await writer.createPage({
        sectionId: args.section_id as string,
        title,
        markdown: markdown === undefined || markdown.trim() === '' ? undefined : markdown,
      });
      return answerWrite('create', outcome, args.section_id as string);
    },
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
        page_id: { type: 'string', description: 'A page id from list_pages, search_notes or create_page, a page address, or a card ref such as DEE-12.' },
        markdown: { type: 'string', description: 'The text to add, as Markdown.' },
      },
      required: ['page_id', 'markdown'],
      additionalProperties: false,
    },
    annotations: writes,
    async run(context, args) {
      const markdown = args.markdown as string;
      if (markdown.trim() === '') return failure('The markdown is empty. Give the text to add to the page.');
      const pageId = await pageIdFor(context, args.page_id as string);
      return answerWrite('append', await context.writer.appendToPage({ pageId, markdown }), pageId);
    },
  },
];

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

/** The mirror's manifest, or the sentence a read tool answers when there is none to read. */
function mirrorManifest({ mirror }: McpContext): MirrorManifest | string {
  if (mirror === null) {
    return 'The notes read tools read the server\'s mirror, which is off. Set LOOSELEAF_MIRROR=on (or leave it unset) and restart the server. The board tools and the write tools work without it.';
  }
  return mirror.manifest ?? 'The mirror of the notes is still being built. Try again in a few seconds.';
}

/** The page a caller named by a page id, a page address or a card ref. */
function pageIdFor({ boards }: McpContext, text: string): Promise<string> {
  return boards.pageId(text);
}

/** A name or title on one line: line breaks become spaces and the ends are trimmed. */
function oneLine(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, ' ').trim();
}

function success(text: string): McpToolResult {
  return { content: [{ type: 'text', text }] };
}

function failure(text: string): McpToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}
