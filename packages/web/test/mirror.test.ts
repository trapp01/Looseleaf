import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as Y from 'yjs';
import {
  addImageContainer,
  addTextContainer,
  createNotebook,
  createPage,
  createSection,
  LIBRARY_DOC_ID,
  MIRROR_MANIFEST_FILE,
  notebookDocId,
  pageDocId,
  parseMirrorManifest,
  renameNode,
} from '@looseleaf/model';
import { blobHash, MemoryStore, SyncClient } from '@looseleaf/sync';
import { CHANNELS } from '../../desktop/src/channels.js';
import { createHandlers } from '../../desktop/src/ipc.js';
import type { MirrorBatch, MirrorBatchResult, MirrorFolderChoice } from '../src/shell-bridge.js';
import { MirrorRunner, startMirror, type MirrorBridge } from '../src/mirror/mirror-runner.js';

const DELAY = 40;
const runners: MirrorRunner[] = [];
const clients: SyncClient[] = [];
afterEach(async () => {
  for (const runner of runners.splice(0)) await runner.close();
  for (const client of clients.splice(0)) await client.close();
  vi.restoreAllMocks();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const paragraph = (text: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });

async function client(): Promise<SyncClient> {
  const made = await SyncClient.create({ store: new MemoryStore(), tabChannel: null });
  clients.push(made);
  return made;
}

/** Changes a doc and waits until the change is in the replica store, which is when the mirror hears of it. */
async function edit(client: SyncClient, docId: string, change: (doc: Y.Doc) => void): Promise<void> {
  const doc = await client.openDoc(docId);
  change(doc);
  client.releaseDoc(docId);
  await client.flush();
}

/** A notebook "Work" with a section "Projects" and `count` pages titled "Page 1", "Page 2", …, each with one paragraph. */
async function library(sync: SyncClient, count: number) {
  let notebookId = '';
  let sectionId = '';
  const pages: string[] = [];
  await edit(sync, LIBRARY_DOC_ID, (doc) => (notebookId = createNotebook(doc, { name: 'Work' })));
  await edit(sync, notebookDocId(notebookId), (doc) => {
    sectionId = createSection(doc, { name: 'Projects', parent: null });
    for (let i = 1; i <= count; i++) pages.push(createPage(doc, { section: sectionId, title: `Page ${i}` }));
  });
  for (const [i, pageId] of pages.entries()) {
    await edit(sync, pageDocId(pageId), (doc) => addTextContainer(doc, { x: 0, y: 0, width: 300, body: paragraph(`Invented text ${i + 1}`) }));
  }
  await sync.flush();
  return { notebookId, sectionId, pages };
}

/**
 * The desktop shell's real handlers over a temp user data folder, with the
 * folder picker answering `controls.picked`. Every batch is recorded;
 * `failNext` makes the next apply reject the way an unwritable folder does.
 */
function desktopShell(picked: string | null = mkdtempSync(join(tmpdir(), 'looseleaf-mirror-'))) {
  const userData = mkdtempSync(join(tmpdir(), 'looseleaf-user-data-'));
  const handlers = createHandlers({
    platform: 'darwin',
    homeDir: '/nowhere',
    env: {},
    saveFolder: '/nowhere',
    writeFile: async () => undefined,
    mirrorSettingFile: join(userData, 'mirror-folder.json'),
  });
  const controls = { failNext: 0, picked, afterApply: async (_batch: MirrorBatch) => undefined as void };
  const host = { showSaveDialog: async () => null, showFolderDialog: async () => controls.picked, printToPdf: async () => new Uint8Array() };
  const call = (channel: (typeof CHANNELS)[keyof typeof CHANNELS], ...args: unknown[]) =>
    handlers[channel as keyof typeof handlers](host, args);
  const batches: MirrorBatch[] = [];
  const bridge: MirrorBridge = {
    chooseMirrorFolder: async () => (await call(CHANNELS.chooseMirrorFolder)) as MirrorFolderChoice,
    mirrorFolder: async () => (await call(CHANNELS.mirrorFolder)) as string | null,
    stopMirroring: async () => void (await call(CHANNELS.stopMirroring)),
    readMirrorManifest: async () => (await call(CHANNELS.readMirrorManifest)) as Uint8Array | null,
    applyMirrorBatch: async (batch) => {
      batches.push(batch);
      if (controls.failNext > 0) {
        controls.failNext -= 1;
        throw new Error(`Error invoking remote method '${CHANNELS.applyMirrorBatch}': Error: EACCES: permission denied, open '${picked}/x'`);
      }
      const result = (await call(CHANNELS.applyMirrorBatch, batch)) as MirrorBatchResult;
      await controls.afterApply(batch);
      return result;
    },
  };
  return { folder: picked!, bridge, batches, controls };
}

async function mirrored(sync: SyncClient, shell = desktopShell(), limits?: { files: number; bytes: number }) {
  const runner = new MirrorRunner({ bridge: shell.bridge, client: sync, delayMs: DELAY, limits });
  runners.push(runner);
  await runner.chooseFolder();
  await runner.whenIdle();
  return { runner, ...shell };
}

function filesUnder(folder: string): string[] {
  return readdirSync(folder, { recursive: true, withFileTypes: true })
    .filter((item) => item.isFile())
    .map((item) => join(item.parentPath, item.name).slice(folder.length + 1).split('\\').join('/'))
    .sort();
}

const read = (folder: string, path: string) => readFileSync(join(folder, ...path.split('/')), 'utf8');

describe('desktop mirror', () => {
  it('writes the page file for an edit once, after the delay', async () => {
    const sync = await client();
    const { pages } = await library(sync, 2);
    const { runner, folder, batches } = await mirrored(sync);
    expect(filesUnder(folder)).toEqual([MIRROR_MANIFEST_FILE, 'Work/Projects/Page 1.md', 'Work/Projects/Page 2.md']);
    expect(runner.state.get()).toEqual({ folder, status: 'up-to-date', error: null });
    const before = batches.length;

    await edit(sync, pageDocId(pages[0]!), (doc) => addTextContainer(doc, { x: 0, y: 200, width: 300, body: paragraph('Added later') }));
    await sync.flush();
    await sleep(DELAY / 2);
    expect(batches.length).toBe(before);
    await runner.whenIdle();
    expect(batches.length).toBe(before + 1);
    expect(batches.at(-1)!.pages.map((page) => page.path)).toEqual(['Work/Projects/Page 1.md']);
    expect(read(folder, 'Work/Projects/Page 1.md')).toContain('Added later');
  });

  it('coalesces rapid edits to one page into one batch', async () => {
    const sync = await client();
    const { pages } = await library(sync, 1);
    const { runner, folder, batches } = await mirrored(sync);
    const before = batches.length;
    for (let i = 0; i < 5; i++) {
      await edit(sync, pageDocId(pages[0]!), (doc) => addTextContainer(doc, { x: 0, y: 100 * (i + 1), width: 300, body: paragraph(`Typed ${i}`) }));
      await sleep(DELAY / 4);
    }
    await runner.whenIdle();
    expect(batches.length).toBe(before + 1);
    expect(read(folder, 'Work/Projects/Page 1.md')).toContain('Typed 4');
  });

  it('moves the file when a page is renamed', async () => {
    const sync = await client();
    const { notebookId, pages } = await library(sync, 2);
    const { runner, folder, batches } = await mirrored(sync);
    await edit(sync, notebookDocId(notebookId), (doc) => renameNode(doc, pages[1]!, 'Renamed page'));
    await runner.whenIdle();
    const last = batches.at(-1)!;
    expect(last.removals).toEqual(['Work/Projects/Page 2.md']);
    expect(last.pages.map((page) => page.path)).toEqual(['Work/Projects/Renamed page.md']);
    expect(filesUnder(folder)).toEqual([MIRROR_MANIFEST_FILE, 'Work/Projects/Page 1.md', 'Work/Projects/Renamed page.md']);
  });

  it('sends a first run on a large library in bounded batches, each leaving a manifest that matches the folder', async () => {
    const sync = await client();
    const { pages } = await library(sync, 450);
    const shell = desktopShell();
    const limits = { files: 100, bytes: 64 * 1024 };
    shell.controls.afterApply = async () => {
      // After every batch, each page the manifest on disk lists is on disk with the bytes it records,
      // and every page file on disk is listed, so a later plan can remove it.
      const manifest = parseMirrorManifest(readFileSync(join(shell.folder, MIRROR_MANIFEST_FILE)))!;
      for (const page of manifest.pages) expect(blobHash(readFileSync(join(shell.folder, ...page.path.split('/'))))).toBe(page.hash);
      const onDisk = filesUnder(shell.folder).filter((name) => name.endsWith('.md'));
      expect(manifest.pages.map((page) => page.path).sort()).toEqual(onDisk);
    };
    const { folder, batches } = await mirrored(sync, shell, limits);
    expect(batches.length).toBeGreaterThanOrEqual(5);
    for (const batch of batches) {
      expect(batch.removals.length + batch.assets.length + batch.pages.length).toBeLessThanOrEqual(limits.files);
    }
    const manifest = parseMirrorManifest(readFileSync(join(folder, MIRROR_MANIFEST_FILE)))!;
    expect(manifest.pages.map((page) => page.id)).toEqual(pages);
    const files = filesUnder(folder);
    expect(files).toHaveLength(451);
    expect(files.filter((name) => name.includes('.looseleaf-tmp-'))).toEqual([]);
    for (const page of manifest.pages) expect(read(folder, page.path)).toContain(`Invented text ${page.title.slice(5)}`);
  });

  it('stops a plan before its next batch when another folder is chosen, leaving both folders consistent', async () => {
    const sync = await client();
    const { pages } = await library(sync, 300);
    const shell = desktopShell();
    const second = mkdtempSync(join(tmpdir(), 'looseleaf-mirror-'));
    const runner = new MirrorRunner({ bridge: shell.bridge, client: sync, delayMs: DELAY, limits: { files: 50, bytes: 1 << 20 } });
    runners.push(runner);
    let changing: Promise<void> | null = null;
    shell.controls.afterApply = async () => {
      if (changing !== null) return;
      shell.controls.picked = second;
      changing = runner.chooseFolder();
    };
    await runner.chooseFolder();
    await runner.whenIdle();
    await changing;
    await runner.whenIdle();
    expect(runner.state.get()).toEqual({ folder: second, status: 'up-to-date', error: null });

    const first = parseMirrorManifest(readFileSync(join(shell.folder, MIRROR_MANIFEST_FILE)))!;
    expect(first.pages.length).toBeLessThan(pages.length);
    for (const page of first.pages) expect(blobHash(readFileSync(join(shell.folder, ...page.path.split('/'))))).toBe(page.hash);
    const complete = parseMirrorManifest(readFileSync(join(second, MIRROR_MANIFEST_FILE)))!;
    expect(complete.pages.map((page) => page.id)).toEqual(pages);
    expect(filesUnder(second)).toHaveLength(pages.length + 1);
  });

  it('reports a failed apply and tries again at the next change', async () => {
    const sync = await client();
    const { pages } = await library(sync, 1);
    const { runner, folder, controls } = await mirrored(sync);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    controls.failNext = 1;
    await edit(sync, pageDocId(pages[0]!), (doc) => addTextContainer(doc, { x: 0, y: 200, width: 300, body: paragraph('First try') }));
    await runner.whenIdle();
    expect(runner.state.get()).toEqual({
      folder,
      status: 'failed',
      error: `EACCES: permission denied, open '${folder}/x'`,
    });
    expect(read(folder, 'Work/Projects/Page 1.md')).not.toContain('First try');

    await edit(sync, LIBRARY_DOC_ID, (doc) => doc.getMap('unrelated').set('touch', 1));
    await runner.whenIdle();
    expect(runner.state.get().status).toBe('up-to-date');
    expect(read(folder, 'Work/Projects/Page 1.md')).toContain('First try');
  });

  it('replaces the placeholder for a picture once its blob arrives', async () => {
    const sync = await client();
    const { pages } = await library(sync, 1);
    const picture = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 7]);
    const hash = blobHash(picture);
    await edit(sync, pageDocId(pages[0]!), (doc) =>
      addImageContainer(doc, { x: 0, y: 100, width: 10, height: 10, blob: hash, mime: 'image/png', name: 'dot.png', size: picture.length }),
    );
    const { runner, folder } = await mirrored(sync);
    const waiting = read(folder, 'Work/Projects/Page 1.md');
    expect(waiting).not.toContain(`assets/${hash}`);
    expect(parseMirrorManifest(readFileSync(join(folder, MIRROR_MANIFEST_FILE)))!.pages[0]!.missingBlobs).toEqual([hash]);

    await sync.putBlob(picture);
    await runner.whenIdle();
    expect(read(folder, 'Work/Projects/Page 1.md')).toContain(`../../assets/${hash}.png`);
    expect(readFileSync(join(folder, 'assets', `${hash}.png`))).toEqual(Buffer.from(picture));
  });

  it('stops on Stop mirroring, leaving the files, and refuses a folder holding other files', async () => {
    const sync = await client();
    const { pages } = await library(sync, 1);
    const { runner, folder, batches } = await mirrored(sync);
    await runner.stop();
    expect(runner.state.get().folder).toBeNull();
    const before = batches.length;
    await edit(sync, pageDocId(pages[0]!), (doc) => addTextContainer(doc, { x: 0, y: 200, width: 300, body: paragraph('Not mirrored') }));
    await sleep(DELAY * 2);
    await runner.whenIdle();
    expect(batches.length).toBe(before);
    expect(filesUnder(folder)).toEqual([MIRROR_MANIFEST_FILE, 'Work/Projects/Page 1.md']);

    const occupied = mkdtempSync(join(tmpdir(), 'looseleaf-occupied-'));
    writeFileSync(join(occupied, 'Spec.md'), 'their own notes');
    const other = desktopShell(occupied);
    const refused = new MirrorRunner({ bridge: other.bridge, client: sync, delayMs: DELAY });
    runners.push(refused);
    await refused.chooseFolder();
    expect(refused.state.get()).toEqual({ folder: null, status: 'not-empty', error: null });
    expect(other.batches).toEqual([]);
  });

  it('does nothing without a desktop shell', async () => {
    const sync = await client();
    expect(startMirror(sync)).toBeNull();
    expect(startMirror(sync, null)).toBeNull();
  });
});
