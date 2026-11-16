import { describe, expect, it } from 'vitest';
import type * as Y from 'yjs';
import {
  LIBRARY_DOC_ID,
  addTextContainer,
  createNotebook,
  createPage,
  createSection,
  notebookDocId,
  pageDocId,
  readPage,
  readTree,
  textContainerBody,
  type SectionEntry,
} from '@looseleaf/model';
import { call, connectedClient, docFromStore, editDoc, mcpClient, TestServer, waitFor, waitForConvergence } from './harness.js';

const DELAY_MS = 100;

describe('the MCP write tools, end to end', () => {
  it('send a created page to a connected client and show it in read_page once the mirror catches up', async () => {
    const server = await TestServer.start({ mirrorDelayMs: DELAY_MS });
    const a = await connectedClient(server);
    let notebook = '';
    let section = '';
    let existing = '';
    await editDoc(a.client, LIBRARY_DOC_ID, (doc) => {
      notebook = createNotebook(doc, { name: 'Work' });
    });
    await editDoc(a.client, notebookDocId(notebook), (doc) => {
      section = createSection(doc, { name: 'Backlog', parent: null });
      existing = createPage(doc, { section, title: 'Ideas' });
    });
    await editDoc(a.client, pageDocId(existing), (doc) =>
      addTextContainer(doc, { x: 0, y: 0, width: 300, body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'First idea' }] }] } }),
    );
    await waitForConvergence(server, [a.store], [notebookDocId(notebook), pageDocId(existing)]);

    const mcp = await mcpClient(server);
    const created = await call(mcp, 'create_page', { section_id: section, title: 'Out of scope', markdown: 'Parked: **offline maps**, come back later.' });
    expect(created.isError).toBe(false);
    const pageId = /page id: (\S+)\)/.exec(created.text)![1]!;

    // The connected client receives the page node and the page's content without asking for them.
    await waitFor(async () => {
      const tree = readTree(await docFromStore(a.store, notebookDocId(notebook)));
      return (tree.children[0] as SectionEntry).pages.some((page) => page.id === pageId && page.title === 'Out of scope');
    }, 'the client to receive the new page');
    await waitFor(async () => {
      const [container] = readPage(await docFromStore(a.store, pageDocId(pageId))).containers;
      return container?.kind === 'text' && JSON.stringify(container.body).includes('offline maps');
    }, 'the client to receive the page text');

    await waitFor(async () => (await call(mcp, 'read_page', { page_id: pageId })).text.includes('Parked: **offline maps**, come back later.'), 'read_page to show the new page');
    const read = await call(mcp, 'read_page', { page_id: pageId });
    expect(read.text).toContain('# Out of scope');
    expect((await call(mcp, 'list_pages', { section_id: section })).text).toContain(`- Out of scope (page id: ${pageId}, level 0)`);
  }, 30_000);

  it('appends to a page another client is editing, and every replica ends with both edits', async () => {
    const server = await TestServer.start({ mirrorDelayMs: DELAY_MS });
    const a = await connectedClient(server);
    let notebook = '';
    let page = '';
    let container = '';
    await editDoc(a.client, LIBRARY_DOC_ID, (doc) => {
      notebook = createNotebook(doc, { name: 'Work' });
    });
    await editDoc(a.client, notebookDocId(notebook), (doc) => {
      page = createPage(doc, { section: createSection(doc, { name: 'Backlog', parent: null }), title: 'Ideas' });
    });
    await editDoc(a.client, pageDocId(page), (doc) => {
      container = addTextContainer(doc, { x: 0, y: 0, width: 300, body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'base' }] }] } });
    });
    await waitForConvergence(server, [a.store], [notebookDocId(notebook), pageDocId(page)]);
    const b = await connectedClient(server);

    const mcp = await mcpClient(server);
    const [appended] = await Promise.all([
      call(mcp, 'append_to_page', { page_id: page, markdown: '- [ ] follow up' }),
      editDoc(a.client, pageDocId(page), (doc) => {
        const paragraph = textContainerBody(doc, container).get(0) as Y.XmlElement;
        (paragraph.get(0) as Y.XmlText).insert(0, 'typed ');
      }),
    ]);
    expect(appended.isError).toBe(false);

    const converged = await waitForConvergence(server, [a.store, b.store], [pageDocId(page)]);
    const [text] = readPage(converged.get(pageDocId(page))!).containers;
    if (text?.kind !== 'text') throw new Error('not a text container');
    expect(text.body.content!.map((block) => JSON.stringify(block))).toEqual([
      expect.stringContaining('typed base'),
      expect.stringContaining('follow up'),
    ]);
    await waitFor(async () => (await call(mcp, 'read_page', { page_id: page })).text.includes('typed base\n\n- [ ] follow up'), 'read_page to show both edits');
  }, 30_000);
});
