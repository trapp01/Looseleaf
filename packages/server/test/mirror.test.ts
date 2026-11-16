import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as Y from 'yjs';
import {
  LIBRARY_DOC_ID,
  MIRROR_MANIFEST_FILE,
  addImageContainer,
  addTextContainer,
  createNotebook,
  createPage,
  createSection,
  deleteNode,
  moveNode,
  notebookDocId,
  pageDocId,
  renameNode,
  type MirrorManifest,
} from '@looseleaf/model';
import { blobHash } from '@looseleaf/sync';
import { MirrorFolder } from '../src/mirror-folder.js';
import {
  connectedClient,
  editDoc,
  tempDir,
  TestServer,
  TOKEN,
  waitFor,
  waitForConvergence,
  waitForSynced,
} from './harness.js';

const DELAY_MS = 100;
const CREATED = Date.UTC(2026, 3, 2, 8, 0);

afterEach(() => {
  vi.restoreAllMocks();
});

function paragraph(text: string) {
  return { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] };
}

function addText(doc: Y.Doc, text: string, y = 0): void {
  addTextContainer(doc, { x: 0, y, width: 300, body: paragraph(text) });
}

/** A server with a short mirror delay, a connected client, and one notebook holding Work/Notes/Plan. */
async function mirrored(options: { dataDir?: string } = {}) {
  const server = await TestServer.start({ mirrorDelayMs: DELAY_MS, ...options });
  const a = await connectedClient(server);
  let notebookId = '';
  let sectionId = '';
  let pageId = '';
  await editDoc(a.client, LIBRARY_DOC_ID, (doc) => {
    notebookId = createNotebook(doc, { name: 'Work' });
  });
  await editDoc(a.client, notebookDocId(notebookId), (doc) => {
    sectionId = createSection(doc, { name: 'Notes', parent: null });
    pageId = createPage(doc, { section: sectionId, title: 'Agenda', createdAt: CREATED });
  });
  await editDoc(a.client, pageDocId(pageId), (doc) => addText(doc, 'first line'));
  const root = join(server.dataDir, 'mirror');
  await waitForFile(join(root, 'Work/Notes/Agenda.md'), 'first line');
  await idle(server);
  return { server, a, notebookId, sectionId, pageId, root };
}

function idle(server: TestServer): Promise<void> {
  return server.current.mirror!.whenIdle();
}

async function readText(path: string): Promise<string | null> {
  return readFile(path, 'utf8').catch(() => null);
}

async function waitForFile(path: string, contains: string): Promise<string> {
  let text: string | null = null;
  await waitFor(async () => (text = await readText(path)) !== null && text.includes(contains), `${path} to contain "${contains}"`);
  return text!;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

/** Every file under the folder with its inode and mtime, by relative path. */
async function listing(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (folder: string, prefix: string) => {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) await walk(path, `${prefix}${entry.name}/`);
      else {
        const info = await stat(path);
        out[`${prefix}${entry.name}`] = `${info.ino}@${info.mtimeMs}`;
      }
    }
  };
  await walk(root, '');
  return out;
}

async function manifestOf(root: string): Promise<MirrorManifest> {
  return JSON.parse(await readFile(join(root, MIRROR_MANIFEST_FILE), 'utf8')) as MirrorManifest;
}

describe('the server mirror', () => {
  it('writes a page file after an edit, with front matter, and lists it in the manifest', async () => {
    const { server, root, pageId, notebookId, sectionId } = await mirrored();
    const text = await readFile(join(root, 'Work/Notes/Agenda.md'), 'utf8');
    expect(text).toBe(
      `---\nid: "${pageId}"\nnotebook: "Work"\nsection: "Notes"\n---\n\n# Agenda\n\nCreated: ${new Date(CREATED).toISOString()}\n\nfirst line\n`,
    );
    const manifest = await manifestOf(root);
    expect(manifest.pages).toEqual([expect.objectContaining({ id: pageId, notebookId, sectionId, path: 'Work/Notes/Agenda.md' })]);
    expect(server.current.mirror!.manifest).toEqual(manifest);
    expect(server.current.mirror!.root).toBe(root);
  });

  it('rewrites the file once for a burst of edits', async () => {
    const { server, a, pageId, root } = await mirrored();
    const apply = vi.spyOn(MirrorFolder.prototype, 'apply');
    const doc = await a.client.openDoc(pageDocId(pageId));
    for (let i = 0; i < 5; i++) {
      addText(doc, `burst ${i}`, 100 + i * 10);
      await new Promise((resolve) => setTimeout(resolve, DELAY_MS / 5));
    }
    await waitForFile(join(root, 'Work/Notes/Agenda.md'), 'burst 4');
    await idle(server);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply.mock.calls[0]![0].writes.map((f) => f.path)).toEqual(['Work/Notes/Agenda.md']);
  });

  it('runs one plan at a time and picks up changes that arrive during a plan', async () => {
    const { server, a, pageId, root } = await mirrored();
    const original = MirrorFolder.prototype.apply;
    let active = 0;
    let most = 0;
    vi.spyOn(MirrorFolder.prototype, 'apply').mockImplementation(async function (this: MirrorFolder, ...args) {
      active += 1;
      most = Math.max(most, active);
      await new Promise((resolve) => setTimeout(resolve, DELAY_MS * 3));
      try {
        return await original.apply(this, args);
      } finally {
        active -= 1;
      }
    });
    await editDoc(a.client, pageDocId(pageId), (doc) => addText(doc, 'during one', 100));
    await new Promise((resolve) => setTimeout(resolve, DELAY_MS * 2));
    await editDoc(a.client, pageDocId(pageId), (doc) => addText(doc, 'during two', 200));
    await waitForFile(join(root, 'Work/Notes/Agenda.md'), 'during two');
    await idle(server);
    expect(most).toBe(1);
  });

  it('follows a rename, a move and a delete', async () => {
    const { server, a, notebookId, sectionId, pageId, root } = await mirrored();
    const nb = notebookDocId(notebookId);
    await editDoc(a.client, nb, (doc) => renameNode(doc, pageId, 'Roadmap'));
    await waitForFile(join(root, 'Work/Notes/Roadmap.md'), '# Roadmap');
    await idle(server);
    expect(await exists(join(root, 'Work/Notes/Agenda.md'))).toBe(false);

    let archive = '';
    await editDoc(a.client, nb, (doc) => {
      archive = createSection(doc, { name: 'Archive', parent: null });
      moveNode(doc, pageId, { parent: archive });
    });
    await waitForFile(join(root, 'Work/Archive/Roadmap.md'), 'section: "Archive"');
    await idle(server);
    expect(await exists(join(root, 'Work/Notes'))).toBe(false);

    await editDoc(a.client, nb, (doc) => deleteNode(doc, archive));
    await waitFor(async () => !(await exists(join(root, 'Work'))), 'the notebook folder to go');
    await idle(server);
    expect((await manifestOf(root)).pages).toEqual([]);
    expect(sectionId).not.toBe(archive);
  });

  it('never touches a file it did not write', async () => {
    const { server, a, notebookId, pageId, root } = await mirrored();
    await writeFile(join(root, 'notes.txt'), 'mine');
    await writeFile(join(root, 'Work/Notes/mine.md'), 'mine too');
    await editDoc(a.client, notebookDocId(notebookId), (doc) => deleteNode(doc, pageId));
    await waitFor(async () => !(await exists(join(root, 'Work/Notes/Agenda.md'))), 'the page file to go');
    await server.stop();
    await server.startAgain();
    await idle(server);
    expect(await readFile(join(root, 'notes.txt'), 'utf8')).toBe('mine');
    expect(await readFile(join(root, 'Work/Notes/mine.md'), 'utf8')).toBe('mine too');
  });

  it('rebuilds a deleted manifest at the next start without removing anything', async () => {
    const { server, root } = await mirrored();
    const before = await readFile(join(root, MIRROR_MANIFEST_FILE), 'utf8');
    await writeFile(join(root, 'Work/Notes/stray.md'), 'not listed');
    await server.stop();
    await rm(join(root, MIRROR_MANIFEST_FILE));
    await server.startAgain();
    await idle(server);
    expect(await readFile(join(root, MIRROR_MANIFEST_FILE), 'utf8')).toBe(before);
    expect(await exists(join(root, 'Work/Notes/stray.md'))).toBe(true);
  });

  it('rebuilds a corrupted manifest and every file at the next start', async () => {
    const { server, root } = await mirrored();
    const before = await readFile(join(root, MIRROR_MANIFEST_FILE), 'utf8');
    await server.stop();
    await writeFile(join(root, MIRROR_MANIFEST_FILE), '{"format":"looseleaf-mirror","version":1,"pages":"oops"}');
    await writeFile(join(root, 'Work/Notes/Agenda.md'), 'damaged');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await server.startAgain();
    await idle(server);
    expect(await readFile(join(root, MIRROR_MANIFEST_FILE), 'utf8')).toBe(before);
    expect(await readFile(join(root, 'Work/Notes/Agenda.md'), 'utf8')).toContain('first line');
  });

  it('changes no file when the server restarts over unchanged data', async () => {
    const { server, root } = await mirrored();
    const before = await listing(root);
    await server.stop();
    await server.startAgain();
    await idle(server);
    expect(await listing(root)).toEqual(before);
  });

  it('writes nothing with the mirror off', async () => {
    const server = await TestServer.start({ mirror: false, mirrorDelayMs: DELAY_MS });
    const a = await connectedClient(server);
    await editDoc(a.client, LIBRARY_DOC_ID, (doc) => createNotebook(doc, { name: 'Off' }));
    await waitForConvergence(server, [a.store], [LIBRARY_DOC_ID]);
    await new Promise((resolve) => setTimeout(resolve, DELAY_MS * 3));
    expect(server.current.mirror).toBeNull();
    expect(await exists(join(server.dataDir, 'mirror'))).toBe(false);
  });

  it('replaces a missing picture with the asset once its blob is uploaded', async () => {
    const { server, a, pageId, root } = await mirrored();
    const bytes = new TextEncoder().encode('picture bytes');
    const hash = blobHash(bytes);
    await editDoc(a.client, pageDocId(pageId), (doc) =>
      addImageContainer(doc, { x: 0, y: 50, width: 10, height: 10, blob: hash, mime: 'image/png', name: 'sketch.png', size: bytes.length }),
    );
    await waitForFile(join(root, 'Work/Notes/Agenda.md'), '[Missing picture: sketch.png]');
    await idle(server);
    expect((await manifestOf(root)).pages[0]!.missingBlobs).toEqual([hash]);

    const put = await fetch(`${server.url}/api/blobs/${hash}`, { method: 'PUT', headers: { Authorization: `Bearer ${TOKEN}` }, body: bytes });
    expect(put.status).toBe(201);
    await waitForFile(join(root, 'Work/Notes/Agenda.md'), `![sketch.png](../../assets/${hash}.png)`);
    expect(await readFile(join(root, `assets/${hash}.png`), 'utf8')).toBe('picture bytes');
    await idle(server);
    expect((await manifestOf(root)).pages[0]!.missingBlobs).toEqual([]);
  });

  it('keeps syncing when the mirror cannot be written, and logs the failure', async () => {
    const dataDir = await tempDir();
    await mkdir(dataDir, { recursive: true });
    await writeFile(join(dataDir, 'mirror'), 'a file where the folder should be');
    const errors: unknown[][] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void errors.push(args));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const server = await TestServer.start({ dataDir, mirrorDelayMs: DELAY_MS });
    const a = await connectedClient(server);
    await editDoc(a.client, LIBRARY_DOC_ID, (doc) => createNotebook(doc, { name: 'Still syncs' }));
    await waitForConvergence(server, [a.store], [LIBRARY_DOC_ID]);
    await waitForSynced(a.client);
    await waitFor(() => errors.length >= 2, 'the start-up check and the change to be logged');
    expect(String(errors[0]![0])).toContain(`Could not update the mirror in ${join(dataDir, 'mirror')}`);
    expect(await readFile(join(dataDir, 'mirror'), 'utf8')).toBe('a file where the folder should be');
  });

  it('mirrors both edits once two replicas that edited the same page apart converge', async () => {
    const { server, a, pageId, root } = await mirrored();
    const b = await connectedClient(server);
    await waitForConvergence(server, [a.store, b.store], [LIBRARY_DOC_ID, pageDocId(pageId)]);
    for (const replica of [a, b]) {
      replica.control.blocked = true;
      replica.control.cutAll();
    }
    await waitFor(() => a.client.status.state === 'offline' && b.client.status.state === 'offline', 'both replicas offline');
    await editDoc(a.client, pageDocId(pageId), (doc) => addText(doc, 'written on A', 100));
    await editDoc(b.client, pageDocId(pageId), (doc) => addText(doc, 'written on B', 200));
    a.control.blocked = false;
    b.control.blocked = false;
    await Promise.all([waitForSynced(a.client), waitForSynced(b.client)]);
    await waitForConvergence(server, [a.store, b.store], [pageDocId(pageId)]);
    const path = join(root, 'Work/Notes/Agenda.md');
    await waitFor(async () => /written on A[\s\S]*written on B/.test((await readText(path)) ?? ''), 'both edits in the mirrored file');
    expect(await readText(path)).toContain('first line');
  });
});
