import { mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type * as Y from 'yjs';
import {
  LIBRARY_DOC_ID,
  addImageContainer,
  addTextContainer,
  createGroup,
  createNotebook,
  createPage,
  createSection,
  notebookDocId,
  pageDocId,
} from '@looseleaf/model';
import { blobHash } from '@looseleaf/sync';
import { SEARCH_DEFAULT_LIMIT, SEARCH_MAX_LIMIT } from '../src/mcp-notes-tools.js';
import { MCP_TOOLS } from '../src/mcp-tools.js';
import { MCP_MAX_BODY_BYTES, MCP_PROTOCOL_VERSIONS } from '../src/mcp.js';
import { SERVER_VERSION, startServer, type RunningServer } from '../src/server.js';
import { call, connectedClient, editDoc, makeClient, mcpClient, TestServer, TOKEN, waitFor, waitForSynced } from './harness.js';

const DELAY_MS = 100;
const CREATED = Date.UTC(2026, 3, 2, 8, 0);
const PICTURE = new TextEncoder().encode('invented picture bytes');
const LONG_LINE = `${'filler '.repeat(60)}saffron${' filler'.repeat(60)}`;

afterEach(() => {
  vi.restoreAllMocks();
});

function textBody(...paragraphs: string[]) {
  return { type: 'doc', content: paragraphs.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] })) };
}

function addText(doc: Y.Doc, ...paragraphs: string[]): void {
  addTextContainer(doc, { x: 0, y: 0, width: 300, body: textBody(...paragraphs) });
}

/** What a library needs from a server: a harness TestServer, or one shared by a describe block. */
type LibraryServer = Pick<TestServer, 'url' | 'dataDir' | 'current'>;

interface Library {
  server: LibraryServer;
  edit: (docId: string, change: (doc: Y.Doc) => void) => Promise<void>;
  root: string;
  garden: string;
  kitchen: string;
  vegetables: string;
  spring: string;
  recipes: string;
  pages: Record<'planting' | 'seedlings' | 'hardening' | 'checklist' | 'soup' | 'bread' | 'long', string>;
}

/**
 * Garden: Vegetables (Tomato planting, Seedlings as a subpage, Hardening off
 * under it) and Plans / Spring (Spring checklist, with a picture).
 * Kitchen: Recipes (Tomato soup, Bread, Long notes).
 */
async function library(server: LibraryServer): Promise<Library> {
  const a = await makeClient();
  await a.client.connect({ url: server.url, token: TOKEN });
  await waitForSynced(a.client);
  const edit = (docId: string, change: (doc: Y.Doc) => void) => editDoc(a.client, docId, change);
  const ids = { garden: '', kitchen: '', vegetables: '', spring: '', recipes: '' };
  const pages = { planting: '', seedlings: '', hardening: '', checklist: '', soup: '', bread: '', long: '' };
  await edit(LIBRARY_DOC_ID, (doc) => {
    ids.garden = createNotebook(doc, { name: 'Garden' });
    ids.kitchen = createNotebook(doc, { name: 'Kitchen' });
  });
  await edit(notebookDocId(ids.garden), (doc) => {
    ids.vegetables = createSection(doc, { name: 'Vegetables', parent: null });
    pages.planting = createPage(doc, { section: ids.vegetables, title: 'Tomato planting', createdAt: CREATED });
    pages.seedlings = createPage(doc, { section: ids.vegetables, title: 'Seedlings', level: 1, createdAt: CREATED });
    pages.hardening = createPage(doc, { section: ids.vegetables, title: 'Hardening off', level: 2, createdAt: CREATED });
    const plans = createGroup(doc, { name: 'Plans', parent: null });
    ids.spring = createSection(doc, { name: 'Spring', parent: plans });
    pages.checklist = createPage(doc, { section: ids.spring, title: 'Spring checklist', createdAt: CREATED });
  });
  await edit(notebookDocId(ids.kitchen), (doc) => {
    ids.recipes = createSection(doc, { name: 'Recipes', parent: null });
    pages.soup = createPage(doc, { section: ids.recipes, title: 'Tomato soup', createdAt: CREATED });
    pages.bread = createPage(doc, { section: ids.recipes, title: 'Bread', createdAt: CREATED });
    pages.long = createPage(doc, { section: ids.recipes, title: 'Long notes', createdAt: CREATED });
  });
  const put = await fetch(`${server.url}/api/blobs/${blobHash(PICTURE)}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${TOKEN}` },
    body: PICTURE,
  });
  expect(put.status).toBe(201);
  await edit(pageDocId(pages.planting), (doc) => addText(doc, 'Water the tomatoes every morning.', 'Tomatoes like sun.'));
  await edit(pageDocId(pages.seedlings), (doc) =>
    addText(doc, 'basil one', 'basil two', 'basil three', 'basil four', 'basil five'),
  );
  await edit(pageDocId(pages.hardening), (doc) => addText(doc, 'A week outside in the shade first.'));
  await edit(pageDocId(pages.checklist), (doc) => {
    addText(doc, 'Order compost and tomato cages.');
    addImageContainer(doc, {
      x: 0,
      y: 200,
      width: 10,
      height: 10,
      blob: blobHash(PICTURE),
      mime: 'image/png',
      name: 'sprout.png',
      size: PICTURE.length,
    });
  });
  await edit(pageDocId(pages.soup), (doc) => addText(doc, 'Roast tomato halves, then blend.', 'tomato tomato'));
  await edit(pageDocId(pages.bread), (doc) => addText(doc, 'Knead the dough for ten minutes.'));
  await edit(pageDocId(pages.long), (doc) => addText(doc, LONG_LINE));
  const root = join(server.dataDir, 'mirror');
  await waitForFile(join(root, 'Kitchen/Recipes/Long notes.md'), 'saffron');
  await waitForFile(join(root, 'Garden/Plans/Spring/Spring checklist.md'), 'sprout.png](');
  await waitForFile(join(root, 'Kitchen/Recipes/Tomato soup.md'), 'tomato tomato');
  await waitFor(() => server.current.mirror!.manifest?.pages.length === 7, 'seven pages in the manifest');
  await server.current.mirror!.whenIdle();
  return { server, edit, root, ...ids, pages };
}

/**
 * A server that lives for a whole describe block, so read-only tests share
 * one library. The harness stops its servers and removes its folders after
 * every test.
 */
async function serverForAll(): Promise<LibraryServer & { stop(): Promise<void> }> {
  const dataDir = await mkdtemp(join(tmpdir(), 'looseleaf-test-'));
  const current: RunningServer = await startServer({ dataDir, port: 0, token: TOKEN, mirrorDelayMs: DELAY_MS });
  return {
    url: current.url,
    dataDir,
    current,
    stop: async () => {
      await current.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

async function waitForFile(path: string, contains: string): Promise<void> {
  await waitFor(async () => ((await readFile(path, 'utf8').catch(() => '')) as string).includes(contains), `${path} to contain "${contains}"`);
}

/** One raw JSON-RPC POST to /mcp. */
function post(server: TestServer, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${server.url}/mcp`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

/** Result titles of a search, in order. */
function titlesIn(text: string): string[] {
  return [...text.matchAll(/^\d+\. (.+) \(page id: /gm)].map((match) => match[1]!);
}

describe('the MCP endpoint, through the SDK client', () => {
  let shared: Library;
  let sharedServer: Awaited<ReturnType<typeof serverForAll>>;
  beforeAll(async () => {
    sharedServer = await serverForAll();
    shared = await library(sharedServer);
  }, 30_000);
  afterAll(() => sharedServer.stop());

  it('initializes and lists the notes tools, then the board tools, with schemas', async () => {
    const { server } = shared;
    const client = await mcpClient(server);
    expect(client.getServerVersion()).toEqual({ name: 'looseleaf', version: SERVER_VERSION });
    expect(client.getServerCapabilities()).toEqual({ tools: {} });
    expect(client.getInstructions()).toContain('neither changes or removes anything');
    expect(client.getInstructions()).toContain('move_card it to a status of kind doing');
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      'list_notebooks',
      'list_pages',
      'search_notes',
      'read_page',
      'create_page',
      'append_to_page',
      'list_boards',
      'get_board',
      'search_cards',
      'get_card',
      'create_card',
      'update_card',
      'update_checklist',
      'move_card',
      'add_comment',
      'add_link',
      'archive_card',
      'create_status',
      'create_label',
      'create_board',
    ]);
    expect(tools.map((tool) => tool.name)).toEqual(MCP_TOOLS.map((tool) => tool.name));
    const readOnly = ['list_notebooks', 'list_pages', 'search_notes', 'read_page', 'list_boards', 'get_board', 'search_cards', 'get_card'];
    for (const tool of tools) {
      expect(tool.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
      expect(tool.annotations).toEqual({ readOnlyHint: readOnly.includes(tool.name) });
      expect(tool.description).not.toBe('');
    }
    expect(tools[4]!.inputSchema.required).toEqual(['section_id', 'title']);
    expect(tools[5]!.inputSchema.required).toEqual(['page_id', 'markdown']);
    expect(tools[2]!.inputSchema.required).toEqual(['query']);
    expect(tools[2]!.inputSchema.properties!.limit).toMatchObject({ type: 'integer', minimum: 1, maximum: SEARCH_MAX_LIMIT });
    expect(await client.ping()).toEqual({});
    await client.close();
  });

  it('lists notebooks with their sections, group paths, ids and page counts', async () => {
    const lib = shared;
    const client = await mcpClient(lib.server);
    const { text, isError } = await call(client, 'list_notebooks');
    expect(isError).toBe(false);
    expect(text).toBe(
      [
        `Garden (notebook id: ${lib.garden})`,
        `  Vegetables (section id: ${lib.vegetables}, 3 pages)`,
        `  Plans / Spring (section id: ${lib.spring}, 1 page)`,
        '',
        `Kitchen (notebook id: ${lib.kitchen})`,
        `  Recipes (section id: ${lib.recipes}, 3 pages)`,
      ].join('\n'),
    );
  });

  it('lists a section’s pages in order with subpage levels', async () => {
    const lib = shared;
    const client = await mcpClient(lib.server);
    const { text, isError } = await call(client, 'list_pages', { section_id: lib.vegetables });
    expect(isError).toBe(false);
    expect(text).toBe(
      [
        `Section Vegetables (section id: ${lib.vegetables}) in notebook Garden, 3 pages:`,
        `- Tomato planting (page id: ${lib.pages.planting}, level 0)`,
        `  - Seedlings (page id: ${lib.pages.seedlings}, level 1)`,
        `    - Hardening off (page id: ${lib.pages.hardening}, level 2)`,
      ].join('\n'),
    );
    const unknown = await call(client, 'list_pages', { section_id: 'nope' });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toContain('list_notebooks');
  });

  it('reads a page file with its front matter and picture link', async () => {
    const lib = shared;
    const client = await mcpClient(lib.server);
    const { text, isError } = await call(client, 'read_page', { page_id: lib.pages.checklist });
    expect(isError).toBe(false);
    expect(text).toBe(await readFile(join(lib.root, 'Garden/Plans/Spring/Spring checklist.md'), 'utf8'));
    expect(text).toContain(`id: "${lib.pages.checklist}"`);
    expect(text).toContain('section: "Plans / Spring"');
    expect(text).toContain(`![sprout.png](../../../assets/${blobHash(PICTURE)}.png)`);
    const unknown = await call(client, 'read_page', { page_id: 'nope' });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toContain('search_notes');
  });

  it('ranks pages with every word in the title first, then by occurrences', async () => {
    const lib = shared;
    const client = await mcpClient(lib.server);
    const { text, isError } = await call(client, 'search_notes', { query: 'TOMATO' });
    expect(isError).toBe(false);
    expect(text.split('\n')[0]).toBe('3 pages match "TOMATO".');
    expect(titlesIn(text)).toEqual(['Tomato soup', 'Tomato planting', 'Spring checklist']);
    expect(text).toContain(`1. Tomato soup (page id: ${lib.pages.soup})\n   Notebook: Kitchen. Section: Recipes`);
    expect(text).toContain('Notebook: Garden. Section: Plans / Spring\n   > Order compost and tomato cages.');

    // Words may be split between the title and the text.
    const split = await call(client, 'search_notes', { query: '  spring   compost ' });
    expect(titlesIn(split.text)).toEqual(['Spring checklist']);
    const none = await call(client, 'search_notes', { query: 'tomato bread' });
    expect(none).toEqual({ text: 'No pages match "tomato bread".', isError: false });
  });

  it('breaks ties in notebook order and leaves front matter out of the search', async () => {
    const lib = shared;
    const client = await mcpClient(lib.server);
    // Every page has one "Created:" line.
    const created = await call(client, 'search_notes', { query: 'created' });
    expect(titlesIn(created.text)).toEqual(lib.server.current.mirror!.manifest!.pages.map((page) => page.title));
    // "Garden" and the page ids appear only in front matter.
    expect((await call(client, 'search_notes', { query: 'garden' })).text).toBe('No pages match "garden".');
    expect((await call(client, 'search_notes', { query: lib.pages.bread })).text).toContain('No pages match');
  });

  it('shows up to three snippets per page, each cut to about 200 characters', async () => {
    const lib = shared;
    const client = await mcpClient(lib.server);
    const basil = await call(client, 'search_notes', { query: 'basil' });
    expect(basil.text).toContain('   > basil one\n   > basil two\n   > basil three');
    expect(basil.text).not.toContain('basil four');

    const saffron = await call(client, 'search_notes', { query: 'saffron' });
    const snippet = saffron.text.split('\n').find((line) => line.startsWith('   > '))!.slice('   > '.length);
    expect(snippet).toContain('saffron');
    expect(snippet.startsWith('…')).toBe(true);
    expect(snippet.endsWith('…')).toBe(true);
    expect(snippet.length).toBeLessThanOrEqual(202);
    expect(LONG_LINE.length).toBeGreaterThan(400);
  });

  it('applies limit and notebook_id and says how many matched', async () => {
    const lib = shared;
    const client = await mcpClient(lib.server);
    const limited = await call(client, 'search_notes', { query: 'tomato', limit: 1 });
    expect(limited.text.split('\n')[0]).toContain('3 pages match "tomato"; showing the first 1.');
    expect(titlesIn(limited.text)).toEqual(['Tomato soup']);

    const kitchen = await call(client, 'search_notes', { query: 'tomato', notebook_id: lib.kitchen });
    expect(titlesIn(kitchen.text)).toEqual(['Tomato soup']);
    expect(kitchen.text.split('\n')[0]).toBe('1 page matches "tomato".');
    expect(SEARCH_DEFAULT_LIMIT).toBe(20);
  });

  it('answers caller mistakes with isError results', async () => {
    const lib = shared;
    const client = await mcpClient(lib.server);
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ['search_notes', { query: '   ' }, 'The query is empty'],
      ['search_notes', { query: 'tomato', notebook_id: 'nope' }, 'list_notebooks'],
      ['search_notes', { query: 'tomato', limit: 0 }, '"limit" must be from 1 to 100'],
      ['search_notes', { query: 'tomato', limit: SEARCH_MAX_LIMIT + 1 }, '"limit" must be from 1 to 100'],
      ['search_notes', { query: 'tomato', limit: 2.5 }, '"limit" must be a whole number'],
      ['search_notes', {}, 'needs the argument "query"'],
      ['search_notes', { query: 7 }, '"query" must be a string'],
      ['list_notebooks', { extra: true }, 'has no argument "extra"'],
      ['read_page', { page_id: lib.pages.bread, other: 1 }, 'Its arguments are page_id'],
    ];
    for (const [name, args, message] of cases) {
      const result = await call(client, name, args);
      expect(result.isError, `${name} ${JSON.stringify(args)}`).toBe(true);
      expect(result.text).toContain(message);
    }
  });

  it('shows a page edited through sync once the mirror has rewritten it', async () => {
    const lib = await library(await TestServer.start({ mirrorDelayMs: DELAY_MS }));
    const client = await mcpClient(lib.server);
    await lib.edit(pageDocId(lib.pages.bread), (doc) =>
      addTextContainer(doc, { x: 0, y: 300, width: 300, body: textBody('Let it rise overnight.') }),
    );
    await waitFor(
      async () => (await call(client, 'read_page', { page_id: lib.pages.bread })).text.includes('Let it rise overnight.'),
      'read_page to show the edit',
    );
    expect(titlesIn((await call(client, 'search_notes', { query: 'overnight' })).text)).toEqual(['Bread']);
  });

  it('skips a page whose file is missing in search and says read_page should be retried', async () => {
    const lib = await library(await TestServer.start({ mirrorDelayMs: DELAY_MS }));
    const client = await mcpClient(lib.server);
    await unlink(join(lib.root, 'Kitchen/Recipes/Tomato soup.md'));
    expect(titlesIn((await call(client, 'search_notes', { query: 'tomato' })).text)).toEqual(['Tomato planting', 'Spring checklist']);
    const read = await call(client, 'read_page', { page_id: lib.pages.soup });
    expect(read.isError).toBe(true);
    expect(read.text).toContain('being rewritten');
  });
});

describe('the MCP endpoint over raw HTTP', () => {
  it('refuses a missing or wrong token before reading the body', async () => {
    const server = await TestServer.start({ mirrorDelayMs: DELAY_MS });
    const none = await fetch(`${server.url}/mcp`, { method: 'POST', body: '{}' });
    expect(none.status).toBe(401);
    expect(await none.json()).toEqual({ error: 'missing or wrong access token' });
    const wrong = await post(server, { jsonrpc: '2.0', id: 1, method: 'ping' }, { Authorization: 'Bearer nope' });
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual({ error: 'missing or wrong access token' });
  });

  it('answers GET and DELETE with 405 and Allow: POST', async () => {
    const server = await TestServer.start({ mirrorDelayMs: DELAY_MS });
    for (const method of ['GET', 'DELETE']) {
      const response = await fetch(`${server.url}/mcp`, { method, headers: { Authorization: `Bearer ${TOKEN}` } });
      expect(response.status).toBe(405);
      expect(response.headers.get('allow')).toBe('POST');
      expect(response.headers.get('content-type')).toContain('application/json');
    }
  });

  it('serves the board and write tools with the mirror off, and says the notes read tools need it', async () => {
    const server = await TestServer.start({ mirror: false });
    const client = await mcpClient(server);
    for (const name of ['list_notebooks', 'search_notes', 'read_page', 'list_pages']) {
      const args = name === 'search_notes' ? { query: 'x' } : name === 'read_page' ? { page_id: 'x' } : name === 'list_pages' ? { section_id: 'x' } : {};
      const read = await call(client, name, args);
      expect(read.isError, name).toBe(true);
      expect(read.text).toContain('LOOSELEAF_MIRROR');
    }
    expect(await call(client, 'list_boards')).toEqual({ text: 'There are no boards yet. Make one on a notebook with create_board.', isError: false });
  });

  it('allows the MCP headers in a CORS preflight', async () => {
    const server = await TestServer.start({ mirrorDelayMs: DELAY_MS });
    const response = await fetch(`${server.url}/mcp`, { method: 'OPTIONS' });
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-methods')).toContain('POST');
    for (const header of ['Authorization', 'Content-Type', 'Accept', 'Mcp-Protocol-Version', 'Mcp-Session-Id']) {
      expect(response.headers.get('access-control-allow-headers')).toContain(header);
    }
  });

  it('answers malformed JSON, batches and oversized bodies with errors', async () => {
    const server = await TestServer.start({ mirrorDelayMs: DELAY_MS });
    const malformed = await post(server, '{"jsonrpc":"2.0",');
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ jsonrpc: '2.0', id: null, error: { code: -32700 } });

    const batch = await post(server, [{ jsonrpc: '2.0', id: 1, method: 'ping' }]);
    expect(batch.status).toBe(400);
    expect(await batch.json()).toMatchObject({ error: { code: -32600 } });

    const oversized = await post(server, { jsonrpc: '2.0', id: 1, method: 'ping', params: { pad: 'x'.repeat(MCP_MAX_BODY_BYTES) } });
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toMatchObject({ error: { code: -32600 } });
  });

  it('answers a notification and a client response with 202 and no body', async () => {
    const server = await TestServer.start({ mirrorDelayMs: DELAY_MS });
    const notification = await post(server, { jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(notification.status).toBe(202);
    expect(await notification.text()).toBe('');
    const response = await post(server, { jsonrpc: '2.0', id: 9, result: {} });
    expect(response.status).toBe(202);
    expect(await response.text()).toBe('');
  });

  it('answers an unknown method with -32601 and an unknown tool with -32602', async () => {
    const server = await TestServer.start({ mirrorDelayMs: DELAY_MS });
    const method = await post(server, { jsonrpc: '2.0', id: 1, method: 'resources/list' });
    expect(method.status).toBe(200);
    expect(method.headers.get('content-type')).toContain('application/json');
    expect(await method.json()).toMatchObject({ jsonrpc: '2.0', id: 1, error: { code: -32601 } });
    const tool = await post(server, { jsonrpc: '2.0', id: 'two', method: 'tools/call', params: { name: 'write_page', arguments: {} } });
    expect(await tool.json()).toMatchObject({ jsonrpc: '2.0', id: 'two', error: { code: -32602 } });
  });

  it('answers its newest protocol version to one it does not know, and refuses an unknown version header', async () => {
    const server = await TestServer.start({ mirrorDelayMs: DELAY_MS });
    const params = { protocolVersion: '1999-01-01', capabilities: {}, clientInfo: { name: 'raw', version: '0' } };
    const unknown = await post(server, { jsonrpc: '2.0', id: 1, method: 'initialize', params });
    expect(await unknown.json()).toMatchObject({ result: { protocolVersion: MCP_PROTOCOL_VERSIONS[0], serverInfo: { name: 'looseleaf' } } });
    const known = await post(server, { jsonrpc: '2.0', id: 2, method: 'initialize', params: { ...params, protocolVersion: '2025-06-18' } });
    expect(await known.json()).toMatchObject({ result: { protocolVersion: '2025-06-18' } });
    const header = await post(server, { jsonrpc: '2.0', id: 3, method: 'ping' }, { 'Mcp-Protocol-Version': '1999-01-01' });
    expect(header.status).toBe(400);
  });

  it('keeps every read inside the mirror, whatever the names hold', async () => {
    const server = await TestServer.start({ mirrorDelayMs: DELAY_MS });
    const a = await connectedClient(server);
    const titles = ['../../token', '..', '/etc/passwd', 'C:\\Windows\\win.ini', 'a/../../b', '.looseleaf-mirror.json', '~/.ssh/id_rsa'];
    let notebook = '';
    const pageIds: string[] = [];
    await editDoc(a.client, LIBRARY_DOC_ID, (doc) => {
      notebook = createNotebook(doc, { name: '../..' });
    });
    await editDoc(a.client, notebookDocId(notebook), (doc) => {
      const section = createSection(doc, { name: '..', parent: null });
      for (const title of titles) pageIds.push(createPage(doc, { section, title, createdAt: CREATED }));
    });
    for (const [n, id] of pageIds.entries()) await editDoc(a.client, pageDocId(id), (doc) => addText(doc, `invented text number ${n}`));
    await waitFor(() => server.current.mirror!.manifest?.pages.length === titles.length, 'every hostile page in the manifest');
    await server.current.mirror!.whenIdle();

    const client = await mcpClient(server);
    for (const [n, id] of pageIds.entries()) {
      await waitFor(async () => (await call(client, 'read_page', { page_id: id })).text.includes(`invented text number ${n}`), `page ${id}`);
      const { text } = await call(client, 'read_page', { page_id: id });
      expect(text.startsWith(`---\nid: "${id}"\n`)).toBe(true);
      expect(text).not.toContain(TOKEN);
    }
    const searched = await call(client, 'search_notes', { query: 'invented', limit: 100 });
    expect(titlesIn(searched.text)).toHaveLength(titles.length);

    // A page file swapped for a symlink out of the mirror is refused, not followed.
    const page = server.current.mirror!.manifest!.pages[0]!;
    const outside = join(server.dataDir, 'outside.txt');
    await rm(join(server.current.mirror!.root, page.path));
    await writeFile(outside, 'outside the mirror');
    await symlink(outside, join(server.current.mirror!.root, page.path));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const refused = await post(server, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read_page', arguments: { page_id: page.id } } });
    const body = await refused.text();
    expect(JSON.parse(body)).toMatchObject({ error: { code: -32603 } });
    expect(body).not.toContain('outside the mirror');
    expect(body).toContain('resolves outside');
  }, 30_000);
});
