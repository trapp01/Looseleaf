/**
 * The `import-corkboard` command: moves one Corkboard board into one Looseleaf
 * notebook, with the Looseleaf server stopped. It refuses, changing nothing,
 * whenever the import could not be whole; works out every change in memory
 * (`corkboard-import.ts`); and for a real run marks the data folder
 * (`corkboard-import-marker.ts`), copies the blobs, stores each doc's change
 * and reads the folder back to check it (`corkboard-import-check.ts`). The
 * Corkboard folder is only ever read, through `DataFolderReader`.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, isAbsolute } from 'node:path';
import { parseArgs } from 'node:util';
import * as Y from 'yjs';
import {
  LIBRARY_DOC_ID,
  boardDocId,
  listNotebooks,
  normalizeBoardKey,
  notebookDocId,
  notebookIdOfBoardDoc,
  pageDocId,
  readBoardMeta,
  readTree,
  type NotebookEntry,
  type TreeChild,
} from '@looseleaf/model';
import { CORKBOARD_WORKSPACE_DOC_ID, listCorkboardBoards, readCorkboardBoard, type CorkboardBoard, type CorkboardBoardEntry, type CorkboardLabel } from './corkboard-folder.js';
import { checkImport, type ImportResult } from './corkboard-import-check.js';
import { readImportMarker, unfinishedImport, writeImportMarker, type ImportMarker } from './corkboard-import-marker.js';
import { formatReport, type ImportReport } from './corkboard-import-report.js';
import { ImportDocs, planImport } from './corkboard-import.js';
import { DataFolderReader, UnreadableDocError } from './data-folder-reader.js';
import { DiskStore } from './disk-store.js';
import { Hub } from './hub.js';
import { imageSize } from './image-size.js';

/** An import that cannot go ahead; nothing was written. The message says what to do. */
export class ImportRefusal extends Error {}

export interface ImportOptions {
  /** The Looseleaf data folder. */
  dataDir: string;
  /** The Corkboard server's data folder. */
  corkboardDir: string;
  /** The Corkboard board's key, name or id; may be left out when Corkboard has one board. */
  board?: string;
  /** The Looseleaf notebook's id or name. */
  notebook: string;
  /** A JSON file of label ties: `{ "Label name": "Section" or "Group / Section" }`. */
  tiesFile?: string;
  dryRun: boolean;
  /** Where the JSON report goes; beside the data folder when left out. */
  reportPath?: string;
  /** Epoch ms for the board's created time; now when left out. */
  now?: number;
}

export interface ImportOutcome {
  report: ImportReport;
  reportPath: string;
  /** Why the JSON report could not be saved, or null when it was. The printed report holds the same. */
  reportError: string | null;
  /** The report as printed. */
  text: string;
  /** False when the check found differences. */
  ok: boolean;
}

export const IMPORT_USAGE = `Usage: import-corkboard --corkboard <Corkboard data folder> --notebook <id or name> [--board <key or name>] [--ties <file>] [--dry-run] [--report <file>]
The Looseleaf data folder is LOOSELEAF_DATA (./data when unset). Stop the Looseleaf server and copy its data folder first.`;

/** The command's options from its arguments (after the command name) and the environment. Throws ImportRefusal on a mistake. */
export function parseImportArgs(args: string[], env: NodeJS.ProcessEnv): ImportOptions {
  let values;
  try {
    ({ values } = parseArgs({
      args,
      strict: true,
      allowPositionals: false,
      options: {
        corkboard: { type: 'string' },
        board: { type: 'string' },
        notebook: { type: 'string' },
        ties: { type: 'string' },
        'dry-run': { type: 'boolean', default: false },
        report: { type: 'string' },
      },
    }));
  } catch (error) {
    throw new ImportRefusal(`${(error as Error).message}.\n${IMPORT_USAGE}`);
  }
  if (values.corkboard === undefined || values.notebook === undefined) {
    throw new ImportRefusal(`Name the Corkboard data folder with --corkboard and the notebook with --notebook.\n${IMPORT_USAGE}`);
  }
  return {
    dataDir: resolve(env.LOOSELEAF_DATA ?? './data'),
    corkboardDir: resolve(values.corkboard),
    board: values.board,
    notebook: values.notebook,
    tiesFile: values.ties,
    dryRun: values['dry-run'] === true,
    reportPath: values.report === undefined ? undefined : resolve(values.report),
  };
}

/**
 * Runs the import and writes its JSON report. Resolves with the report
 * whether or not the check found differences; throws ImportRefusal, having
 * written nothing, when the import cannot go ahead.
 */
export async function importCorkboard(options: ImportOptions): Promise<ImportOutcome> {
  const dataDir = resolve(options.dataDir);
  const corkboardDir = resolve(options.corkboardDir);
  if (inside(dataDir, corkboardDir) || inside(corkboardDir, dataDir)) {
    throw new ImportRefusal(`The Corkboard folder (${corkboardDir}) and the Looseleaf data folder (${dataDir}) overlap; name two separate folders.`);
  }
  const unfinished = await unfinishedImport(dataDir);
  if (unfinished !== null) throw new ImportRefusal(unfinished);

  const sourceFolder = new DataFolderReader(corkboardDir);
  const targetFolder = new DataFolderReader(dataDir);
  const docs = new ImportDocs(targetFolder);
  const source = await readable(() => readSource(sourceFolder, corkboardDir, options.board));
  const notebook = await readable(() => findTarget(targetFolder, docs, dataDir, options.notebook, source.entry.key));
  const tree = await readable(async () => readTree(await docs.get(notebookDocId(notebook.id))).children);
  const ties = await readTies(options.tiesFile, source.labels, tree);
  const blobs = await checkBlobs(sourceFolder, source);

  const now = options.now ?? Date.now();
  const plan = await readable(() => planImport({ source, docs, notebookId: notebook.id, ties, pictureSizes: blobs.pictureSizes, now }));
  if (plan.clashes.length > 0) {
    throw new ImportRefusal(
      `The data folder already holds pages this import would make (${plan.clashes.map((clash) => `${clash.ref} as ${clash.pageId}`).join(', ')}), ` +
        'as an import that stopped part way leaves them. Restore the copy of the data folder made before that import, then run this one again.',
    );
  }
  const changes = docs.changes();
  const expected = new Set([boardDocId(notebook.id), notebookDocId(notebook.id), ...plan.cards.map((card) => pageDocId(card.pageId))]);
  const unexpected = changes.filter((change) => !expected.has(change.docId));
  if (unexpected.length > 0) throw new Error(`The import changed docs it should not have: ${unexpected.map((change) => change.docId).join(', ')}`);

  let result: ImportResult;
  if (options.dryRun) {
    result = { doc: (docId) => docs.get(docId), blobHeld: async (hash) => blobs.held.has(hash) };
  } else {
    await refuseChangedSince(targetFolder, docs, changes);
    result = await write(dataDir, { boardKey: source.entry.key, notebookId: notebook.id }, changes, blobs.held);
  }
  const check = await checkImport({
    source,
    notebookId: notebook.id,
    ties,
    result,
    before: (docId) => docs.before(docId),
    missingBlobs: new Set(blobs.problems.map((problem) => problem.blob)),
  });
  if (!options.dryRun) await finishMarker(dataDir, check.mismatches.length === 0);

  const sourceCards = new Map(source.cards.map((card) => [card.id, card]));
  const report: ImportReport = {
    dryRun: options.dryRun,
    importedAt: now,
    source: { folder: corkboardDir, boardId: source.entry.id, boardKey: source.entry.key, boardName: source.entry.name },
    target: { folder: dataDir, notebookId: notebook.id, notebookName: notebook.name },
    cards: plan.cards.map((card) => ({ ref: card.ref, pageId: card.pageId, page: card.page, title: sourceCards.get(card.cardId)!.title, sectionId: card.sectionId })),
    titlesReplaced: plan.cards.flatMap((card) =>
      card.replacedTitle === null ? [] : [{ ref: card.ref, pageId: card.pageId, oldTitle: card.replacedTitle, newTitle: sourceCards.get(card.cardId)!.title }],
    ),
    linksNotAdopted: plan.linksNotAdopted,
    sharedPages: plan.sharedPages,
    descriptionsAlreadyOnPage: plan.cards.filter((card) => card.description === 'already on the page').map((card) => card.ref),
    descriptionWarnings: plan.cards.flatMap((card) => card.descriptionWarnings.map((warning) => ({ ref: card.ref, warning }))),
    blobProblems: blobs.problems,
    statusCounts: check.statusCounts,
    totals: check.totals,
    checkedFrom: options.dryRun ? 'memory' : 'disk',
    mismatches: check.mismatches,
  };
  const reportPath = options.reportPath ?? defaultReportPath(dataDir, options.dryRun, now);
  let reportError: string | null = null;
  try {
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    reportError = (error as Error).message;
  }
  return { report, reportPath, reportError, text: formatReport(report), ok: check.mismatches.length === 0 };
}

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

function defaultReportPath(dataDir: string, dryRun: boolean, now: number): string {
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
  return join(dirname(dataDir), `corkboard-import-${dryRun ? 'dry-run-' : ''}${stamp}.json`);
}

/** Turns a damaged doc into a refusal that says what to do. */
async function readable<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (!(error instanceof UnreadableDocError)) throw error;
    throw new ImportRefusal(`${error.message}. Start and stop that folder's server once so it sets the damaged part aside, then run the import again.`);
  }
}

async function readSource(folder: DataFolderReader, dir: string, wanted: string | undefined): Promise<CorkboardBoard> {
  if (!(await folder.hasDoc(CORKBOARD_WORKSPACE_DOC_ID))) {
    throw new ImportRefusal(`${dir} holds no Corkboard workspace (docs/workspace); pass the Corkboard server's data folder, the one holding docs/ and blobs/.`);
  }
  const boards = await listCorkboardBoards(folder);
  const listed = (list: CorkboardBoardEntry[]) => list.map((board) => `  ${board.key}  "${board.name}"${board.archivedAt === null ? '' : ' (archived)'}`).join('\n');
  let entry: CorkboardBoardEntry | undefined;
  if (wanted === undefined) {
    entry = boards.length === 1 ? boards[0] : undefined;
    if (entry === undefined) throw new ImportRefusal(`Corkboard has ${boards.length} boards; name one with --board:\n${listed(boards)}`);
  } else {
    const text = wanted.trim();
    const matches = [
      boards.filter((board) => board.id === text),
      boards.filter((board) => board.key === text.toUpperCase()),
      boards.filter((board) => board.name.trim().toLowerCase() === text.toLowerCase()),
    ].find((list) => list.length > 0) ?? [];
    if (matches.length > 1) throw new ImportRefusal(`Several Corkboard boards are called "${text}"; name one by its key:\n${listed(matches)}`);
    entry = matches[0];
    if (entry === undefined) throw new ImportRefusal(`Corkboard has no board with the key or name "${text}". Its boards are:\n${listed(boards)}`);
  }
  if (entry.key === '' || normalizeBoardKey(entry.key) !== entry.key) {
    throw new ImportRefusal(`The board's key "${entry.key}" is not one Looseleaf can keep; nothing was imported.`);
  }
  const board = await readCorkboardBoard(folder, entry);
  const byNumber = new Map<number, string[]>();
  for (const card of board.cards) byNumber.set(card.number, [...(byNumber.get(card.number) ?? []), card.title]);
  const clashes = [...byNumber].filter(([number, titles]) => titles.length > 1 || !Number.isInteger(number) || number < 1);
  if (clashes.length > 0) {
    throw new ImportRefusal(
      `Some cards on ${entry.key} have no number of their own: ${clashes.map(([number, titles]) => `${number} (${titles.map((title) => `"${title}"`).join(', ')})`).join('; ')}. ` +
        'Start the Corkboard server and change anything on the board so it gives each card its own number, then run the import again.',
    );
  }
  return board;
}

async function findTarget(folder: DataFolderReader, docs: ImportDocs, dir: string, wanted: string, key: string): Promise<NotebookEntry> {
  if (!(await folder.hasDoc(LIBRARY_DOC_ID))) {
    throw new ImportRefusal(`${dir} holds no Looseleaf library (docs/library); set LOOSELEAF_DATA to the Looseleaf server's data folder.`);
  }
  const notebooks = listNotebooks(await docs.get(LIBRARY_DOC_ID));
  const text = wanted.trim();
  const byId = notebooks.filter((notebook) => notebook.id === text);
  const matches = byId.length > 0 ? byId : notebooks.filter((notebook) => notebook.name.trim().toLowerCase() === text.toLowerCase());
  if (matches.length > 1) {
    throw new ImportRefusal(`Several notebooks are called "${text}"; name one by its id with --notebook:\n${matches.map((notebook) => `  ${notebook.id}  "${notebook.name}"`).join('\n')}`);
  }
  const notebook = matches[0];
  if (notebook === undefined) {
    throw new ImportRefusal(`No notebook has the id or name "${text}". The notebooks are:\n${notebooks.map((entry) => `  ${entry.id}  "${entry.name}"`).join('\n')}`);
  }
  const existing = readBoardMeta(await docs.get(boardDocId(notebook.id)));
  if (existing !== null) {
    throw new ImportRefusal(`The notebook "${notebook.name}" already has a board, with the key ${existing.key}; import into a notebook without one.`);
  }
  const all = listNotebooks(await docs.get(LIBRARY_DOC_ID), { includeDeleted: true });
  for (const docId of await folder.listDocs()) {
    const owner = notebookIdOfBoardDoc(docId);
    if (owner === null || owner === notebook.id) continue;
    if (readBoardMeta(await docs.get(docId))?.key === key) {
      const name = all.find((entry) => entry.id === owner)?.name ?? owner;
      throw new ImportRefusal(`The board on the notebook "${name}" already has the key ${key}, so the imported refs would change; import into a data folder where no board uses it.`);
    }
  }
  return notebook;
}

/** Label id → section id from the ties file, every label and section checked. */
async function readTies(file: string | undefined, labels: CorkboardLabel[], tree: TreeChild[]): Promise<Map<string, string>> {
  const ties = new Map<string, string>();
  if (file === undefined) return ties;
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    throw new ImportRefusal(`The ties file ${file} cannot be read as JSON (${(error as Error).message}); it holds one object, { "Label name": "Section name" }.`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ImportRefusal(`The ties file ${file} must hold one object, { "Label name": "Section name" or "Group / Section" }.`);
  }
  const sections = sectionPaths(tree);
  for (const [labelName, sectionName] of Object.entries(raw)) {
    const named = labels.filter((label) => label.name.trim().toLowerCase() === labelName.trim().toLowerCase());
    if (named.length === 0) throw new ImportRefusal(`The board has no label "${labelName}"; its labels are ${labels.map((label) => `"${label.name}"`).join(', ') || 'none'}. Fix the ties file.`);
    if (named.length > 1) throw new ImportRefusal(`The board has ${named.length} labels called "${labelName}", so a tie cannot say which; tie them in Looseleaf after the import instead.`);
    if (typeof sectionName !== 'string') throw new ImportRefusal(`The tie for "${labelName}" must be a section name or a "Group / Section" path.`);
    const wanted = sectionName.split('/').map((part) => part.trim().toLowerCase()).join(' / ');
    const found = sections.filter((section) => section.path.toLowerCase() === wanted || (!wanted.includes(' / ') && section.name.trim().toLowerCase() === wanted));
    if (found.length === 0) throw new ImportRefusal(`The notebook has no section "${sectionName}" for the label "${labelName}". Make the section in Looseleaf first, or fix the ties file.`);
    if (found.length > 1) {
      throw new ImportRefusal(`Several sections match "${sectionName}" for the label "${labelName}"; write its path instead:\n${found.map((section) => `  ${section.path}`).join('\n')}`);
    }
    ties.set(named[0]!.id, found[0]!.id);
  }
  return ties;
}

function sectionPaths(children: TreeChild[], prefix = ''): Array<{ id: string; name: string; path: string }> {
  return children.flatMap((child) => {
    const path = `${prefix}${child.name.trim()}`;
    return child.kind === 'group' ? sectionPaths(child.children, `${path} / `) : [{ id: child.id, name: child.name, path }];
  });
}

/** Reads and verifies every attachment's blob in the Corkboard folder, and the size of each picture. */
async function checkBlobs(folder: DataFolderReader, source: CorkboardBoard) {
  const held = new Map<string, Uint8Array>();
  const pictureSizes = new Map<string, { width: number; height: number }>();
  const problems: ImportReport['blobProblems'] = [];
  for (const card of source.cards) {
    for (const attachment of card.attachments) {
      const checked = held.has(attachment.blob) ? { bytes: held.get(attachment.blob)! } : await folder.checkedBlob(attachment.blob);
      if ('problem' in checked) {
        problems.push({ ref: `${source.entry.key}-${card.number}`, name: attachment.name, blob: attachment.blob, problem: checked.problem });
        continue;
      }
      held.set(attachment.blob, checked.bytes);
      const size = attachment.mime.startsWith('image/') ? imageSize(checked.bytes) : null;
      if (size !== null) pictureSizes.set(attachment.blob, size);
    }
  }
  return { held, pictureSizes, problems };
}

/** Refuses when a doc the import changes is no longer as it was read: something else is writing to the data folder. */
async function refuseChangedSince(folder: DataFolderReader, docs: ImportDocs, changes: Array<{ docId: string }>): Promise<void> {
  for (const { docId } of changes) {
    const now = Y.encodeStateVector(await folder.readDoc(docId));
    if (!Buffer.from(now).equals(Buffer.from(docs.readVector(docId)!))) {
      throw new ImportRefusal(`The doc "${docId}" changed while the import was working it out; stop the Looseleaf server and run the import again.`);
    }
  }
}

/**
 * Marks the folder, copies the blobs, then stores each change (pages, then
 * the notebook, then the board) through a hub, as a client's update would be
 * stored. Resolves with the folder read again from disk.
 */
async function write(
  dataDir: string,
  marker: Pick<ImportMarker, 'boardKey' | 'notebookId'>,
  changes: Array<{ docId: string; update: Uint8Array }>,
  blobs: ReadonlyMap<string, Uint8Array>,
): Promise<ImportResult> {
  await writeImportMarker(dataDir, { ...marker, state: 'started', startedAt: new Date().toISOString(), endedAt: null });
  const store = new DiskStore(dataDir);
  await store.init();
  for (const [hash, bytes] of blobs) {
    const stored = await store.putBlob(bytes);
    if (stored !== hash) throw new Error(`The blob ${hash} was stored as ${stored}`);
  }
  const hub = new Hub(store, 'unused');
  try {
    for (const { docId, update } of changes) await hub.withDoc(docId, (doc) => Y.applyUpdate(doc, update));
  } finally {
    await hub.close();
    await store.drain();
  }
  const fresh = new DataFolderReader(dataDir);
  return {
    doc: (docId) => fresh.readDoc(docId),
    blobHeld: async (hash) => 'bytes' in (await fresh.checkedBlob(hash)),
  };
}

async function finishMarker(dataDir: string, matched: boolean): Promise<void> {
  const marker = (await readImportMarker(dataDir))!;
  await writeImportMarker(dataDir, { ...marker, state: matched ? 'finished' : 'differences', endedAt: new Date().toISOString() });
}
