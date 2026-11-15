import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  LIBRARY_DOC_ID,
  addFileContainer,
  addImageContainer,
  addStroke,
  addTextContainer,
  createGroup,
  createNotebook,
  createPage,
  createSection,
  deleteNode,
  deleteNotebook,
  exportPage,
  exportZip,
  notebookDocId,
  pageDocId,
  setPaperStyle,
  type JSONContent,
  type PageJson,
} from '../src/index.js';
import { MemoryReplica, PNG_BYTES, sha256 } from './helpers.js';

const CREATED = Date.UTC(2026, 0, 5, 14, 30);

const body: JSONContent = {
  type: 'doc',
  content: [
    { type: 'paragraph', attrs: { tag: 'todo', checked: true }, content: [{ type: 'text', text: 'Done thing' }] },
    {
      type: 'paragraph',
      attrs: { indent: 1, textAlign: 'right' },
      content: [
        { type: 'text', text: '<b>&', marks: [{ type: 'bold' }] },
        { type: 'text', text: ' safe', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] },
      ],
    },
    { type: 'image', attrs: { blob: 'e'.repeat(64), mime: 'image/png', alt: 'lost' } },
  ],
};

/** A library with one notebook holding a page with every kind of content. */
async function setup() {
  const replica = new MemoryReplica();
  const hash = await replica.putBlob(PNG_BYTES);
  const library = await replica.getDoc(LIBRARY_DOC_ID);
  const notebookId = createNotebook(library, { name: 'Work: 2026' });
  const nb = await replica.getDoc(notebookDocId(notebookId));
  const group = createGroup(nb, { name: 'Clients', parent: null });
  const section = createSection(nb, { name: 'Acme', parent: group });
  const pageId = createPage(nb, { section, title: 'Kickoff', createdAt: CREATED });
  createPage(nb, { section, title: 'Kickoff' });
  createPage(nb, { section, title: 'a/b?' });
  const pg = await replica.getDoc(pageDocId(pageId));
  setPaperStyle(pg, 'ruled-college');
  addTextContainer(pg, { x: 20, y: 30, width: 400, body });
  addImageContainer(pg, { x: 500, y: 30, width: 64, height: 48, blob: hash, mime: 'image/png', name: 'logo.png', size: PNG_BYTES.length });
  addFileContainer(pg, { x: 500, y: 200, width: 100, blob: 'd'.repeat(64), mime: 'application/pdf', name: 'brief.pdf', size: 10 });
  addStroke(pg, { tool: 'highlighter', color: '#ffee00', width: 10, points: [0, 0, 100, 50] });
  return { replica, notebookId, section, pageId, hash, nb };
}

const asText = (files: { path: string; data: Uint8Array }[], i = 0) => strFromU8(files[i]!.data);

describe('page export', () => {
  it('writes a self-contained HTML page', async () => {
    const { replica, notebookId, pageId, hash } = await setup();
    const files = await exportPage(replica, notebookId, pageId, 'html');
    expect(files.map((f) => f.path)).toEqual(['Kickoff.html']);
    const html = asText(files);
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain('<title>Kickoff</title>');
    expect(html).toContain(`<time datetime="${new Date(CREATED).toISOString()}">`);
    expect(html).toContain('style="left: 20px; top: 30px; width: 400px; z-index: 0"');
    expect(html).toContain('<input type="checkbox" disabled checked> Done thing');
    expect(html).toContain('<p style="text-align: right; margin-left: 36px"><strong>&lt;b&gt;&amp;</strong>');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('Missing picture: lost');
    expect(html).toContain('Missing file: brief.pdf');
    expect(html).toContain(`src="data:image/png;base64,${Buffer.from(PNG_BYTES).toString('base64')}"`);
    expect(html).toMatch(/<svg class="ink"[^>]*><polyline points="0,0 100,50"[^>]*stroke-opacity="0.4"/);
    expect(html).toContain('background-size: 22px 22px');
    expect(html).toContain('@media print');
    expect(hash).toBe(sha256(PNG_BYTES));
  });

  it('writes Markdown with its assets', async () => {
    const { replica, notebookId, pageId, hash } = await setup();
    const files = await exportPage(replica, notebookId, pageId, 'markdown');
    expect(files.map((f) => f.path)).toEqual(['Kickoff.md', `assets/${hash}.png`]);
    const md = asText(files);
    expect(md.split('\n\n').slice(0, 3)).toEqual(['# Kickoff', `Created: ${new Date(CREATED).toISOString()}`, '- [x] Done thing']);
    expect(md).toContain('**\\<b\\>&** safe');
    expect(md).toContain('[Missing picture: lost]');
    expect(md).toContain(`![logo.png](assets/${hash}.png)`);
    expect(md).toContain('[Missing file: brief.pdf]');
  });

  it('writes plain text', async () => {
    const { replica, notebookId, pageId } = await setup();
    const text = asText(await exportPage(replica, notebookId, pageId, 'text'));
    expect(text).toBe(
      `Kickoff\n\nCreated: ${new Date(CREATED).toISOString()}\n\n[x] Done thing\n  <b>& safe\n[Picture: lost]\n\n[Picture: logo.png]\n\n[File: brief.pdf]\n`,
    );
  });

  it('writes lossless JSON with blobs by hash', async () => {
    const { replica, notebookId, pageId, hash } = await setup();
    const files = await exportPage(replica, notebookId, pageId, 'json');
    expect(files.map((f) => f.path)).toEqual(['Kickoff.json', `blobs/${hash}`]);
    const json = JSON.parse(asText(files)) as PageJson;
    expect(json).toMatchObject({
      format: 'looseleaf-page',
      version: 1,
      id: pageId,
      title: 'Kickoff',
      createdAt: CREATED,
      meta: { paperStyle: 'ruled-college', paperColor: null },
    });
    expect(json.containers.map((c) => c.kind)).toEqual(['text', 'image', 'file']);
    expect(json.containers[0]).toMatchObject({ kind: 'text', body: { type: 'doc' } });
    expect(json.strokes).toEqual([expect.objectContaining({ tool: 'highlighter', points: [0, 0, 100, 50] })]);
  });

  it('throws for a page the notebook does not have', async () => {
    const { replica, notebookId, section } = await setup();
    await expect(exportPage(replica, notebookId, 'nope', 'html')).rejects.toThrow(/no page nope/);
    await expect(exportPage(replica, notebookId, section, 'html')).rejects.toThrow(/no page/);
  });

  it('treats a blob read that fails as missing', async () => {
    const { replica, notebookId, pageId } = await setup();
    replica.getBlob = async () => {
      throw new Error('disk gone');
    };
    const html = asText(await exportPage(replica, notebookId, pageId, 'html'));
    expect(html).toContain('Missing picture: logo.png');
  });
});

describe('zip export', () => {
  it('mirrors the notebook tree with safe, unique names', async () => {
    const { replica, notebookId } = await setup();
    const zip = unzipSync(await exportZip(replica, { kind: 'notebook', notebookId }, 'html'));
    expect(Object.keys(zip).sort()).toEqual(
      [
        'Work- 2026/',
        'Work- 2026/Clients/',
        'Work- 2026/Clients/Acme/',
        'Work- 2026/Clients/Acme/Kickoff.html',
        'Work- 2026/Clients/Acme/Kickoff (2).html',
        'Work- 2026/Clients/Acme/a-b-.html',
      ].sort(),
    );
  });

  it('exports one section', async () => {
    const { replica, notebookId, section } = await setup();
    const zip = unzipSync(await exportZip(replica, { kind: 'section', notebookId, sectionId: section }, 'text'));
    expect(Object.keys(zip).sort()).toEqual(['Acme/', 'Acme/Kickoff.txt', 'Acme/Kickoff (2).txt', 'Acme/a-b-.txt'].sort());
  });

  it('exports the library, leaving deleted notebooks and nodes out', async () => {
    const { replica, nb, pageId } = await setup();
    const library = await replica.getDoc(LIBRARY_DOC_ID);
    createNotebook(library, { name: 'Work: 2026' });
    const gone = createNotebook(library, { name: 'Gone' });
    deleteNotebook(library, gone);
    deleteNode(nb, pageId);
    const zip = unzipSync(await exportZip(replica, { kind: 'library' }, 'markdown'));
    const paths = Object.keys(zip);
    expect(paths).toContain('Work- 2026 (2)/');
    expect(paths.some((p) => p.startsWith('Gone'))).toBe(false);
    expect(paths).toContain('Work- 2026/Clients/Acme/Kickoff.md');
    expect(paths).not.toContain('Work- 2026/Clients/Acme/Kickoff (2).md');
    expect(paths.filter((p) => p.startsWith('assets/'))).toEqual([]);
  });

  it('puts Markdown assets once at the zip root', async () => {
    const { replica, notebookId, hash } = await setup();
    const zip = unzipSync(await exportZip(replica, { kind: 'notebook', notebookId }, 'markdown'));
    expect(zip[`assets/${hash}.png`]).toEqual(PNG_BYTES);
    expect(strFromU8(zip['Work- 2026/Clients/Acme/Kickoff.md']!)).toContain(`(../../../assets/${hash}.png)`);
  });

  it('throws for a scope that does not exist', async () => {
    const { replica, notebookId } = await setup();
    await expect(exportZip(replica, { kind: 'notebook', notebookId: 'nope' }, 'html')).rejects.toThrow(/nope/);
    await expect(exportZip(replica, { kind: 'section', notebookId, sectionId: 'nope' }, 'html')).rejects.toThrow(/no section nope/);
  });
});
