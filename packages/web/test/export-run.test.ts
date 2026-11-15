import { describe, expect, it } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import * as Y from 'yjs';
import {
  addImageContainer,
  addTextContainer,
  createNotebook,
  createPage,
  createSection,
  LIBRARY_DOC_ID,
  notebookDocId,
  pageDocId,
  type DocSource,
} from '@looseleaf/model';
import { blobHash } from '@looseleaf/sync';
import { formatsFor, runExport, scopesFor, type ExportTarget } from '../src/exporting/export-run.js';

function library() {
  const docs = new Map<string, Y.Doc>();
  const doc = (id: string) => {
    let d = docs.get(id);
    if (!d) docs.set(id, (d = new Y.Doc()));
    return d;
  };
  const blobs = new Map<string, Uint8Array>();
  const notebookId = createNotebook(doc(LIBRARY_DOC_ID), { name: 'Work' });
  const nb = doc(notebookDocId(notebookId));
  const sectionId = createSection(nb, { name: 'Plans', parent: null });
  const plain = createPage(nb, { section: sectionId, title: 'Plain page' });
  addTextContainer(doc(pageDocId(plain)), { x: 0, y: 0, width: 300, body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello export' }] }] } });
  const pictured = createPage(nb, { section: sectionId, title: 'With picture' });
  const bytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
  const hash = blobHash(bytes);
  blobs.set(hash, bytes);
  addImageContainer(doc(pageDocId(pictured)), { x: 0, y: 0, width: 10, height: 10, blob: hash, mime: 'image/png', name: 'dot.png', size: bytes.length });
  const source: DocSource = { getDoc: async (id) => doc(id), getBlob: async (h) => blobs.get(h) ?? null };
  const target = (pageId: string | null): ExportTarget => ({
    notebookId,
    sectionId,
    pageId,
    notebookName: 'Work',
    sectionName: 'Plans',
    pageTitle: pageId === plain ? 'Plain page' : 'With picture',
  });
  return { source, plain, pictured, target };
}

describe('runExport', () => {
  it('exports a single page as one file named after its title', async () => {
    const { source, plain, target } = library();
    const html = await runExport(source, { scope: 'page', format: 'html', target: target(plain) });
    expect(html.kind === 'file' && html.name).toBe('Plain page.html');
    expect(html.kind === 'file' && strFromU8(html.bytes)).toContain('Hello export');
    const md = await runExport(source, { scope: 'page', format: 'markdown', target: target(plain) });
    expect(md.kind === 'file' && [md.name, md.mime]).toEqual(['Plain page.md', 'text/markdown']);
  });

  it('zips a page whose export has several files', async () => {
    const { source, pictured, target } = library();
    const result = await runExport(source, { scope: 'page', format: 'markdown', target: target(pictured) });
    if (result.kind !== 'file') throw new Error('expected a file');
    expect(result.name).toBe('With picture.zip');
    const paths = Object.keys(unzipSync(result.bytes)).sort();
    expect(paths[0]).toBe('With picture.md');
    expect(paths[1]).toMatch(/^assets\/[0-9a-f]{64}\.png$/);
  });

  it('exports a section, notebook or everything as a zip named for it', async () => {
    const { source, plain, target } = library();
    const names = [];
    for (const scope of ['section', 'notebook', 'everything'] as const) {
      const result = await runExport(source, { scope, format: 'text', target: target(plain) });
      if (result.kind !== 'file') throw new Error('expected a file');
      names.push(result.name);
      expect(Object.keys(unzipSync(result.bytes)).some((p) => p.endsWith('Plain page.txt'))).toBe(true);
    }
    expect(names).toEqual(['Plans.zip', 'Work.zip', 'Looseleaf.zip']);
  });

  it('turns PDF into printing the page, and offers it for a page only', async () => {
    const { source, plain, target } = library();
    expect(await runExport(source, { scope: 'page', format: 'pdf', target: target(plain) })).toEqual({ kind: 'print', name: 'Plain page.pdf' });
    await expect(runExport(source, { scope: 'section', format: 'pdf', target: target(plain) })).rejects.toThrow();
    expect(formatsFor('page')).toContain('pdf');
    expect(formatsFor('notebook')).not.toContain('pdf');
  });

  it('offers only the scopes the target has', () => {
    const { target } = library();
    expect(scopesFor(target(null))).toEqual(['section', 'notebook', 'everything']);
    expect(scopesFor({ ...target(null), notebookId: null, sectionId: null })).toEqual(['everything']);
  });
});
