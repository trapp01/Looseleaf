/**
 * Test helpers for the Corkboard import: a Corkboard server's data folder
 * written in Corkboard's layout (its `workspace` and `board:<id>` docs, and
 * blobs), filled with invented cards, and a fingerprint of a folder for
 * showing an import left it byte for byte as it was.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import * as Y from 'yjs';
import {
  LIBRARY_DOC_ID,
  addStroke,
  appendToPage,
  createGroup,
  createNotebook,
  createPage,
  createSection,
  deleteNode,
  markdownToBody,
  newId,
  notebookDocId,
  pageDocId,
  type DocAccess,
} from '@looseleaf/model';
import { importCorkboard, type ImportOptions } from '../src/corkboard-import-command.js';
import { DiskStore } from '../src/disk-store.js';
import { Hub } from '../src/hub.js';
import { tempDir, TestServer } from './harness.js';

export interface FixtureCard {
  id: string;
  number: number;
  title: string;
  status: string;
  order: string;
  description?: string;
  labels?: string[];
  due?: string | null;
  checklist?: Array<{ text: string; done: boolean }>;
  comments?: Array<{ id: string; body: string; by: string; at: number; editedAt: number | null }>;
  links?: Array<{ id: string; target: string; title: string; at: number }>;
  attachments?: Array<{ id: string; blob: string; name: string; mime: string; size: number; at: number }>;
  activity?: Array<Record<string, unknown>>;
  createdAt: number;
  createdBy: string;
  updatedAt: number;
  archivedAt?: number | null;
}

export interface FixtureBoard {
  id: string;
  name: string;
  key: string;
  createdAt: number;
  statuses: Array<{ id: string; name: string; kind: string; order: string; archivedAt: number | null }>;
  labels: Array<{ id: string; name: string; color: string; order: string }>;
  cards: FixtureCard[];
}

/** Writes the boards (and any blobs) into `dir` as a Corkboard server stores them. */
export async function writeCorkboardFolder(dir: string, boards: FixtureBoard[], blobs: Uint8Array[] = []): Promise<void> {
  const store = new DiskStore(dir);
  await store.init();
  for (const bytes of blobs) await store.putBlob(bytes);
  const workspace = new Y.Doc();
  workspace.transact(() => {
    for (const board of boards) {
      const map = new Y.Map<unknown>();
      workspace.getMap('boards').set(board.id, map);
      map.set('name', board.name);
      map.set('key', board.key);
      map.set('color', 'teal');
      map.set('order', 'a0');
      map.set('createdAt', board.createdAt);
      map.set('archivedAt', null);
    }
  });
  await store.appendUpdate('workspace', Y.encodeStateAsUpdate(workspace));
  for (const board of boards) {
    // Statuses and labels, then cards: two log records, as a server holds a board changed more than once.
    for (const update of boardUpdates(board)) await store.appendUpdate(`board:${board.id}`, update);
  }
  await store.drain();
}

function boardUpdates(board: FixtureBoard): Uint8Array[] {
  const doc = new Y.Doc();
  const updates: Uint8Array[] = [];
  doc.on('update', (update: Uint8Array) => updates.push(update));
  doc.transact(() => {
    for (const status of board.statuses) {
      const map = new Y.Map<unknown>();
      doc.getMap('statuses').set(status.id, map);
      for (const field of ['name', 'kind', 'order', 'archivedAt'] as const) map.set(field, status[field]);
    }
    for (const label of board.labels) {
      const map = new Y.Map<unknown>();
      doc.getMap('labels').set(label.id, map);
      for (const field of ['name', 'color', 'order'] as const) map.set(field, label[field]);
    }
  });
  doc.transact(() => {
    for (const card of board.cards) {
      const map = new Y.Map<unknown>();
      doc.getMap('cards').set(card.id, map);
      map.set('number', card.number);
      map.set('title', card.title);
      map.set('status', card.status);
      map.set('order', card.order);
      const description = new Y.Text();
      map.set('description', description);
      description.insert(0, card.description ?? '');
      const labels = new Y.Map<boolean>();
      map.set('labels', labels);
      for (const label of card.labels ?? []) labels.set(label, true);
      map.set('due', card.due ?? null);
      const checklist = new Y.Map<Y.Map<unknown>>();
      map.set('checklist', checklist);
      (card.checklist ?? []).forEach((item, index) => {
        const entry = new Y.Map<unknown>();
        checklist.set(`${card.id}-item-${index}`, entry);
        entry.set('text', item.text);
        entry.set('done', item.done);
        entry.set('order', `a${index}`);
      });
      for (const field of ['comments', 'links', 'attachments'] as const) {
        const entries = new Y.Map<unknown>();
        map.set(field, entries);
        for (const { id, ...entry } of card[field] ?? []) entries.set(id, entry);
      }
      const activity = new Y.Array<unknown>();
      map.set('activity', activity);
      activity.push(card.activity ?? []);
      map.set('createdAt', card.createdAt);
      map.set('createdBy', card.createdBy);
      map.set('updatedAt', card.updatedAt);
      map.set('archivedAt', card.archivedAt ?? null);
    }
  });
  return updates;
}

/** The smallest bytes `imageSize` reads as a PNG of this size. */
export function pngBytes(width: number, height: number, salt = 0): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes[32] = salt;
  return bytes;
}

/** Every file and folder under `dir` with a hash of each file's bytes, so two calls compare equal only when nothing changed. */
export async function fingerprint(dir: string): Promise<Record<string, string>> {
  const found: Record<string, string> = {};
  const walk = async (folder: string): Promise<void> => {
    for (const name of (await readdir(folder)).sort()) {
      const path = join(folder, name);
      if ((await stat(path)).isDirectory()) {
        found[`${relative(dir, path)}/`] = 'folder';
        await walk(path);
      } else {
        found[relative(dir, path)] = createHash('sha256').update(await readFile(path)).digest('hex');
      }
    }
  };
  await walk(dir);
  return found;
}

/** The ids the import scenario's Looseleaf folder was made with. */
export interface ScenarioIds {
  notebook: string;
  garden: string;
  bench: string;
  ideas: string;
  shelfNotes: string;
  shedScope: string;
  oldSketch: string;
  bedsPlan: string;
  sharedPlan: string;
  paintNotes: string;
}

export const PICTURE = pngBytes(1280, 720);
export const CUT_LIST = new TextEncoder().encode('An invented cut list');
export const LOST_BLOB = createHash('sha256').update('bytes Corkboard never stored').digest('hex');
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/**
 * Corkboard's board SHOP, invented: statuses Later, Doing, Done and the
 * archived Old; labels Wood, Paint and Misc; seven cards covering an adopted
 * page with a different title, a page two cards link to (one of them linking
 * a free page after it), links to pages in Deleted notes, in another notebook
 * and nowhere, an archived card, a card in an archived status, attachments
 * and a blob Corkboard never held.
 */
export function shopBoard(ids: ScenarioIds): FixtureBoard {
  const page = (id: string) => `looseleaf:${id}`;
  return {
    id: 'board-shop',
    name: 'Shop',
    key: 'SHOP',
    createdAt: 900,
    statuses: [
      { id: 'st-later', name: 'Later', kind: 'todo', order: 'a0', archivedAt: null },
      { id: 'st-doing', name: 'Doing', kind: 'doing', order: 'a1', archivedAt: null },
      { id: 'st-done', name: 'Done', kind: 'done', order: 'a2', archivedAt: null },
      { id: 'st-old', name: 'Old', kind: 'done', order: 'a3', archivedAt: 1_500 },
    ],
    labels: [
      { id: 'lb-wood', name: 'Wood', color: 'orange', order: 'a0' },
      { id: 'lb-paint', name: 'Paint', color: 'red', order: 'a1' },
      { id: 'lb-misc', name: 'Misc', color: 'gray', order: 'a2' },
    ],
    cards: [
      {
        id: 'card-shelf',
        number: 1,
        title: 'Build shelf',
        status: 'st-later',
        order: 'a0',
        description: 'Pine, **two** boards.\n\n- [ ] Measure the wall',
        labels: ['lb-wood'],
        due: '2026-12-01',
        checklist: [
          { text: 'Cut', done: true },
          { text: 'Sand', done: false },
        ],
        comments: [
          { id: 'cm-1', body: 'Bought the pine', by: 'Sam', at: 1_100, editedAt: 1_150 },
          { id: 'cm-2', body: 'Measured *twice*', by: 'agent', at: 1_200, editedAt: null },
        ],
        links: [
          { id: 'ln-1', target: page(ids.shelfNotes), title: 'Shelf notes', at: 1_050 },
          { id: 'ln-2', target: 'https://example.com/shelf', title: 'Plan', at: 1_060 },
        ],
        attachments: [
          { id: 'at-1', blob: sha(PICTURE), name: 'sketch.png', mime: 'image/png', size: PICTURE.length, at: 1_070 },
          { id: 'at-2', blob: sha(CUT_LIST), name: 'cut list.pdf', mime: 'application/pdf', size: CUT_LIST.length, at: 1_080 },
        ],
        activity: [{ type: 'created', at: 1_000, by: 'Sam', status: 'Later' }],
        createdAt: 1_000,
        createdBy: 'Sam',
        updatedAt: 1_200,
      },
      {
        id: 'card-tidy',
        number: 5,
        title: 'Tidy bench',
        status: 'st-later',
        order: 'a1',
        labels: ['lb-misc', 'lb-wood'],
        activity: [{ type: 'created', at: 1_350, by: 'Sam', status: 'Later' }],
        createdAt: 1_350,
        createdBy: 'Sam',
        updatedAt: 1_350,
      },
      {
        id: 'card-brackets',
        number: 2,
        title: 'Shelf brackets',
        status: 'st-doing',
        order: 'a0',
        labels: ['lb-wood'],
        links: [{ id: 'ln-3', target: page(ids.sharedPlan), title: 'Shared plan', at: 1_300 }],
        activity: [
          { type: 'created', at: 1_290, by: 'Sam', status: 'Later' },
          { type: 'moved', at: 1_310, by: 'agent', from: 'Later', to: 'Doing' },
        ],
        createdAt: 1_290,
        createdBy: 'Sam',
        updatedAt: 1_310,
      },
      {
        id: 'card-shed',
        number: 3,
        title: 'Shed scope',
        status: 'st-doing',
        order: 'a1',
        description: 'Walls first,\n   then the roof.',
        labels: ['lb-misc'],
        links: [
          { id: 'ln-4', target: page(ids.bedsPlan), title: 'Beds plan', at: 1_400 },
          { id: 'ln-5', target: page(ids.shedScope), title: 'Shed scope', at: 1_410 },
          { id: 'ln-6', target: page(ids.shedScope), title: 'Shed scope again', at: 1_420 },
        ],
        createdAt: 1_390,
        createdBy: 'agent',
        updatedAt: 1_420,
      },
      {
        id: 'card-paint-shed',
        number: 6,
        title: 'Paint the shed',
        status: 'st-doing',
        order: 'a2',
        links: [
          { id: 'ln-9', target: page(ids.sharedPlan), title: 'Shared plan', at: 1_450 },
          { id: 'ln-10', target: page(ids.paintNotes), title: 'Paint notes', at: 1_460 },
        ],
        createdAt: 1_440,
        createdBy: 'agent',
        updatedAt: 1_460,
      },
      {
        id: 'card-door',
        number: 4,
        title: 'Paint door',
        status: 'st-done',
        order: 'a0',
        labels: ['lb-paint'],
        checklist: [{ text: 'Prime', done: false }],
        links: [
          { id: 'ln-7', target: page(ids.oldSketch), title: 'Old sketch', at: 1_500 },
          { id: 'ln-8', target: page('nOPageHasThisId_0000'), title: 'Gone', at: 1_510 },
        ],
        activity: [
          { type: 'created', at: 1_490, by: 'Sam', status: 'Done' },
          { type: 'archived', at: 1_600, by: 'Sam' },
        ],
        createdAt: 1_490,
        createdBy: 'Sam',
        updatedAt: 1_600,
        archivedAt: 1_600,
      },
      {
        id: 'card-idea',
        number: 7,
        title: 'Old idea',
        status: 'st-old',
        order: 'a0',
        attachments: [{ id: 'at-3', blob: LOST_BLOB, name: 'lost.txt', mime: 'text/plain', size: 10, at: 1_700 }],
        createdAt: 1_690,
        createdBy: 'Sam',
        updatedAt: 1_700,
      },
    ],
  };
}

/**
 * The Looseleaf side: notebooks Workshop (Bench with "Shelf notes", the
 * deleted "Old sketch", "Shared plan" and "Paint notes"; Plans / Ideas with
 * "Shed scope") and Garden (Beds with "Beds plan"). "Shelf notes" holds text,
 * a ticked To Do line and a stroke; "Shed scope" holds SHOP-3's description
 * with other spacing.
 */
export async function makeWorkshop(access: DocAccess): Promise<ScenarioIds> {
  const ids = {} as ScenarioIds;
  await access.withDoc(LIBRARY_DOC_ID, (doc) => {
    ids.notebook = createNotebook(doc, { name: 'Workshop' });
    ids.garden = createNotebook(doc, { name: 'Garden' });
  });
  await access.withDoc(notebookDocId(ids.notebook), (doc) => {
    ids.bench = createSection(doc, { name: 'Bench', parent: null });
    ids.ideas = createSection(doc, { name: 'Ideas', parent: createGroup(doc, { name: 'Plans', parent: null }) });
    ids.shelfNotes = createPage(doc, { section: ids.bench, title: 'Shelf notes' });
    ids.oldSketch = createPage(doc, { section: ids.bench, title: 'Old sketch' });
    deleteNode(doc, ids.oldSketch);
    ids.shedScope = createPage(doc, { section: ids.ideas, title: 'Shed scope' });
    ids.sharedPlan = createPage(doc, { section: ids.bench, title: 'Shared plan' });
    ids.paintNotes = createPage(doc, { section: ids.bench, title: 'Paint notes' });
  });
  await access.withDoc(notebookDocId(ids.garden), (doc) => {
    ids.bedsPlan = createPage(doc, { section: createSection(doc, { name: 'Beds', parent: null }), title: 'Beds plan' });
  });
  const stamp = { now: () => 500, newId };
  const shelf = await markdownToBody('Existing shelf notes\n\n- [x] Buy pine', { stamp });
  await access.withDoc(pageDocId(ids.shelfNotes), (doc) => {
    appendToPage(doc, shelf.body);
    addStroke(doc, { tool: 'pen', color: '#000000', width: 2, points: [0, 0, 10, 10] });
  });
  const shed = await markdownToBody('Scope: walls first, then the roof.\n\nWalls first, then the roof.', { stamp });
  await access.withDoc(pageDocId(ids.shedScope), (doc) => appendToPage(doc, shed.body));
  return ids;
}

/** The time the scenario's imports run at: the board's created time and every imported To Do line's tagged-at time. */
export const NOW = 10_000;

/**
 * A stopped Looseleaf server's folder holding the workshop, a Corkboard
 * folder holding SHOP, and a ties file; `run` imports with them, a real run
 * unless told otherwise.
 */
export async function importScenario(ties: Record<string, string> = { wood: 'Bench', Misc: 'Plans / Ideas' }) {
  const server = await TestServer.start({ mirror: false });
  const ids = await makeWorkshop(server.current.hub);
  await server.stop();
  const corkboardDir = await tempDir();
  await writeCorkboardFolder(corkboardDir, [shopBoard(ids)], [PICTURE, CUT_LIST]);
  const outDir = await tempDir();
  const tiesFile = join(outDir, 'ties.json');
  await writeFile(tiesFile, JSON.stringify(ties));
  const options = (extra: Partial<ImportOptions> = {}): ImportOptions => ({
    dataDir: server.dataDir,
    corkboardDir,
    notebook: 'Workshop',
    tiesFile,
    dryRun: false,
    reportPath: join(outDir, 'report.json'),
    now: NOW,
    ...extra,
  });
  return { server, ids, corkboardDir, outDir, options, run: (extra?: Partial<ImportOptions>) => importCorkboard(options(extra)) };
}

/** Changes a stopped server's docs the way a client would, through a hub of its own. */
export async function offline(dataDir: string, change: (access: DocAccess) => Promise<void>): Promise<void> {
  const store = new DiskStore(dataDir);
  await store.init();
  const hub = new Hub(store, 'unused');
  await change(hub);
  await hub.close();
  await store.drain();
}
