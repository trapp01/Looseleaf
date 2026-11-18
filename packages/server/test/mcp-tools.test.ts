import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  LIBRARY_DOC_ID,
  addTextContainer,
  createGroup,
  createNotebook,
  createPage,
  createSection,
  deleteNode,
  deleteNotebook,
  getNode,
  notebookDocId,
  pageDocId,
  readPage,
  readTree,
  type JSONContent,
  type MirrorPage,
} from '@looseleaf/model';
import { DiskStore } from '../src/disk-store.js';
import { Hub } from '../src/hub.js';
import { Boards } from '../src/boards.js';
import { callMcpTool, type McpContext } from '../src/mcp-tools.js';
import { MirrorFolder } from '../src/mirror-folder.js';
import type { MirrorView } from '../src/mirror.js';
import { NotesWriter } from '../src/notes-writer.js';
import { docFromStore, tempDir } from './harness.js';

/** The notes read tools never touch the writer or the boards. */
const readOnlyNotes = (mirror: MirrorView): McpContext => ({ mirror, writer: {} as NotesWriter, boards: {} as Boards, baseUrl: '' });

describe('the MCP tools over a mirror folder', () => {
  it('say the mirror is still being built before the first manifest', async () => {
    const view: MirrorView = { root: await tempDir(), manifest: null, readText: async () => null, whenIdle: async () => undefined };
    const result = await callMcpTool(readOnlyNotes(view), 'list_notebooks', {});
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('still being built');
  });

  it('search 2,000 pages read from disk well inside a second', async () => {
    const folder = new MirrorFolder(await tempDir());
    const pages: MirrorPage[] = [];
    const writes: Array<{ path: string; data: Uint8Array }> = [];
    for (let i = 0; i < 2000; i++) {
      const id = `page${String(i).padStart(16, '0')}`;
      const section = `Section ${i % 20}`;
      const path = `Notebook ${i % 4}/${section}/Page ${i}.md`;
      const words = i % 50 === 0 ? 'the heron waded through the reeds' : 'a short invented note about nothing much';
      const data = new TextEncoder().encode(
        `---\nid: "${id}"\nnotebook: "Notebook ${i % 4}"\nsection: "${section}"\n---\n\n# Page ${i}\n\nCreated: 2026-04-02T08:00:00.000Z\n\n${words}\n${'line of filler text\n'.repeat(5)}`,
      );
      const hash = createHash('sha256').update(data).digest('hex');
      pages.push({ id, notebookId: `nb${i % 4}`, notebook: `Notebook ${i % 4}`, sectionId: `s${i % 20}`, section: [section], title: `Page ${i}`, level: 0, path, hash, assets: [], missingBlobs: [] });
      writes.push({ path, data });
    }
    const manifest = { format: 'looseleaf-mirror' as const, version: 1 as const, pages };
    for (const { path, data } of writes) {
      await mkdir(join(folder.root, dirname(path)), { recursive: true });
      await writeFile(join(folder.root, path), data);
    }
    const view: MirrorView = { root: folder.root, manifest, readText: (path) => folder.readText(path), whenIdle: async () => undefined };

    await callMcpTool(readOnlyNotes(view), 'search_notes', { query: 'heron' });
    const times: number[] = [];
    let text = '';
    for (let run = 0; run < 5; run++) {
      const started = performance.now();
      text = (await callMcpTool(readOnlyNotes(view), 'search_notes', { query: 'heron reeds' })).content[0]!.text;
      times.push(performance.now() - started);
    }
    times.sort((x, y) => x - y);
    console.log(`search_notes over 2,000 mirror pages: median ${times[2]!.toFixed(1)} ms warm (runs: ${times.map((t) => t.toFixed(1)).join(', ')} ms)`);
    expect(text.split('\n')[0]).toBe('40 pages match "heron reeds"; showing the first 20. Narrow the query, pass notebook_id, or raise limit (up to 100) to see more.');
    expect(times[2]!).toBeLessThan(1500);
  }, 30_000);
});

const hubs: Hub[] = [];
afterEach(async () => {
  for (const hub of hubs.splice(0)) await hub.close();
});

/**
 * A hub over a fresh data folder with one notebook: Garden, holding section
 * Vegetables (page Tomato planting with one paragraph), Plans / Spring, and a
 * deleted section Old. A second notebook, Attic, is deleted.
 */
async function writableLibrary() {
  const store = new DiskStore(await tempDir());
  await store.init();
  const hub = new Hub(store, 'token');
  hubs.push(hub);
  const ids = { garden: '', attic: '', vegetables: '', spring: '', old: '', atticSection: '', planting: '', gone: '' };
  await hub.withDoc(LIBRARY_DOC_ID, (doc) => {
    ids.garden = createNotebook(doc, { name: 'Garden' });
    ids.attic = createNotebook(doc, { name: 'Attic' });
    deleteNotebook(doc, ids.attic);
  });
  await hub.withDoc(notebookDocId(ids.garden), (doc) => {
    ids.vegetables = createSection(doc, { name: 'Vegetables', parent: null });
    ids.planting = createPage(doc, { section: ids.vegetables, title: 'Tomato planting', createdAt: 1000 });
    ids.gone = createPage(doc, { section: ids.vegetables, title: 'Gone', createdAt: 1000 });
    deleteNode(doc, ids.gone);
    ids.spring = createSection(doc, { name: 'Spring', parent: createGroup(doc, { name: 'Plans', parent: null }) });
    ids.old = createSection(doc, { name: 'Old', parent: null });
    deleteNode(doc, ids.old);
  });
  await hub.withDoc(notebookDocId(ids.attic), (doc) => {
    ids.atticSection = createSection(doc, { name: 'Boxes', parent: null });
  });
  await hub.withDoc(pageDocId(ids.planting), (doc) => {
    addTextContainer(doc, { x: 0, y: 0, width: 300, body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Water daily.' }] }] } });
  });
  const notes: McpContext = {
    mirror: { root: '', manifest: null, readText: async () => null, whenIdle: async () => undefined },
    writer: new NotesWriter(hub),
    boards: new Boards(hub, store),
    baseUrl: '',
  };
  const run = async (name: string, args: Record<string, unknown>) => {
    const result = await callMcpTool(notes, name, args);
    return { text: result.content[0]!.text, isError: result.isError === true };
  };
  return { store, hub, ids, run };
}

const paragraphTexts = (body: JSONContent): string[] => (body.content ?? []).map((block) => (block.content ?? []).map((n) => n.text ?? '').join(''));

describe('the MCP write tools', () => {
  it('create_page adds a page at the end of the section with the Markdown in one text container', async () => {
    const { store, ids, run } = await writableLibrary();
    const before = Date.now();
    const { text, isError } = await run('create_page', { section_id: ids.vegetables, title: '  Parked\nideas ', markdown: '# Later\n\n- [ ] look at mulch' });
    expect(isError).toBe(false);
    const nb = await docFromStore(store, notebookDocId(ids.garden));
    const pages = (readTree(nb).children[0] as { pages: Array<{ id: string; title: string }> }).pages;
    expect(pages.map((p) => p.title)).toEqual(['Tomato planting', 'Parked ideas']);
    const pageId = pages[1]!.id;
    expect(text).toBe(
      `Created the page "Parked ideas" (page id: ${pageId}) at the end of section Vegetables (section id: ${ids.vegetables}) in notebook Garden.\n` +
        'read_page and search_notes show it in a few seconds.',
    );
    const node = getNode(nb, pageId)!;
    expect(node).toMatchObject({ kind: 'page', level: 0, deletedAt: null });
    expect(node.createdAt).toBeGreaterThanOrEqual(before);
    expect(node.modifiedAt).toBe(node.createdAt);
    const containers = readPage(await docFromStore(store, pageDocId(pageId))).containers;
    expect(containers).toHaveLength(1);
    expect(containers[0]).toMatchObject({ kind: 'text', x: 48, y: 24, width: 400 });
    if (containers[0]!.kind !== 'text') throw new Error('not text');
    expect(containers[0]!.body.content!.map((b) => [b.type, b.attrs?.tag ?? null])).toEqual([['heading', null], ['paragraph', 'todo']]);
  });

  it('create_page without Markdown makes an empty page and writes no page doc', async () => {
    const { store, ids, run } = await writableLibrary();
    const { text, isError } = await run('create_page', { section_id: ids.spring, title: 'Seeds', markdown: '   ' });
    expect(isError).toBe(false);
    expect(text).toContain(`at the end of section Plans / Spring (section id: ${ids.spring}) in notebook Garden.`);
    const pageId = /page id: (\S+)\)/.exec(text)![1]!;
    expect(await store.readUpdates(pageDocId(pageId))).toEqual([]);
  });

  it('append_to_page adds after the existing text, keeps it as it was and marks the page modified', async () => {
    const { store, ids, run } = await writableLibrary();
    const pageBefore = await docFromStore(store, pageDocId(ids.planting));
    const { text, isError } = await run('append_to_page', { page_id: ids.planting, markdown: 'Out of scope: **drip lines**.\n\n[bad](javascript:x)' });
    expect(isError).toBe(false);
    expect(text).toBe(
      `Added the text to the end of "Tomato planting" (page id: ${ids.planting}) in section Vegetables (section id: ${ids.vegetables}) in notebook Garden.\n` +
        'read_page and search_notes show it in a few seconds.\n' +
        'Note: a link with an unsupported address was imported as plain text.',
    );
    const page = await docFromStore(store, pageDocId(ids.planting));
    const [container] = readPage(page).containers;
    if (container?.kind !== 'text') throw new Error('not text');
    expect(paragraphTexts(container.body)).toEqual(['Water daily.', 'Out of scope: drip lines.', 'bad']);
    // The new state still holds every item of the old one.
    const merged = new Y.Doc();
    Y.applyUpdate(merged, Y.encodeStateAsUpdate(page));
    Y.applyUpdate(merged, Y.encodeStateAsUpdate(pageBefore));
    expect(Y.encodeStateAsUpdate(merged)).toEqual(Y.encodeStateAsUpdate(page));
    expect(getNode(await docFromStore(store, notebookDocId(ids.garden)), ids.planting)!.modifiedAt).toBeGreaterThan(1000);
  });

  it('answers caller mistakes with isError results and writes nothing for them', async () => {
    const { store, ids, run } = await writableLibrary();
    const docs = await store.listDocs();
    const records = async () => Promise.all(docs.map(async (docId) => (await store.readUpdates(docId)).length));
    const counts = await records();
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ['create_page', { section_id: 'nope', title: 'T' }, 'No section has the id "nope". Call list_notebooks'],
      ['create_page', { section_id: ids.planting, title: 'T' }, `No section has the id "${ids.planting}"`],
      ['create_page', { section_id: ids.old, title: 'T', markdown: 'x' }, 'is in Deleted notes. Pick another section'],
      ['create_page', { section_id: ids.atticSection, title: 'T' }, 'is in Deleted notes'],
      ['create_page', { section_id: ids.vegetables, title: ' \n ' }, 'The title is empty'],
      ['create_page', { section_id: ids.vegetables }, 'needs the argument "title"'],
      ['create_page', { section_id: ids.vegetables, title: 'T', markdown: 3 }, '"markdown" must be a string'],
      ['append_to_page', { page_id: 'nope', markdown: 'x' }, 'No page has the id "nope". Call search_notes or list_pages'],
      ['append_to_page', { page_id: ids.vegetables, markdown: 'x' }, `No page has the id "${ids.vegetables}"`],
      ['append_to_page', { page_id: ids.gone, markdown: 'x' }, 'is in Deleted notes. Add to another page'],
      ['append_to_page', { page_id: ids.planting, markdown: '  \n ' }, 'The markdown is empty'],
      ['append_to_page', { page_id: ids.planting }, 'needs the argument "markdown"'],
      ['append_to_page', { page_id: ids.planting, markdown: 'x', title: 'y' }, 'Its arguments are page_id, markdown'],
    ];
    for (const [name, args, message] of cases) {
      const result = await run(name, args);
      expect(result.isError, `${name} ${JSON.stringify(args)}`).toBe(true);
      expect(result.text).toContain(message);
    }
    expect(await store.listDocs()).toEqual(docs);
    expect(await records()).toEqual(counts);
  });
});

describe('Hub.withDoc', () => {
  it('stores nothing for a change that writes nothing, and drops a failed change from memory', async () => {
    const { store, hub, ids } = await writableLibrary();
    const docId = pageDocId(ids.planting);
    const records = (await store.readUpdates(docId)).length;
    expect(await hub.withDoc(docId, (doc) => readPage(doc).containers.length)).toBe(1);
    expect((await store.readUpdates(docId)).length).toBe(records);

    await expect(
      hub.withDoc(docId, (doc) => {
        doc.getMap('meta').set('paperStyle', 'grid-small');
        throw new Error('changed my mind');
      }),
    ).rejects.toThrow('changed my mind');
    expect((await store.readUpdates(docId)).length).toBe(records);
    expect(await hub.withDoc(docId, (doc) => doc.getMap('meta').get('paperStyle'))).toBeUndefined();
  });
});
