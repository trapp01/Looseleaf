/**
 * Importing OneNote notebooks: each source's `.one` files are parsed into an
 * import tree off the main thread, then written into the replica with
 * `importTree`. Progress is reported per section file and per page, and the
 * report comes only once everything is stored on the device. A notebook that
 * fails is listed in the report and the others carry on. The reader's typed
 * errors become sentences a person can act on here.
 */
import type * as Y from 'yjs';
import type { SyncClient } from '@looseleaf/sync';
import { importTree, type DocSink, type ImportedNotebook, type ImportSummary } from '@looseleaf/model';
import { readNotebookFolderLazily } from '@looseleaf/onenote';

export interface ImportFile {
  /** Relative to the notebook folder, with `/` separators. */
  path: string;
  size: number;
  read(): Promise<Uint8Array>;
}

export interface ImportSource {
  notebookName: string;
  files: ImportFile[];
}

export type ImportProgress =
  | { kind: 'reading'; notebook: string; path: string }
  | { kind: 'writing'; notebook: string; pagesDone: number; pagesTotal: number }
  /** Every notebook is written; waiting for the replica store to keep it all. */
  | { kind: 'saving' };

export interface WarningGroup {
  message: string;
  count: number;
  /** Up to three "Section / Page" places it happened. */
  places: string[];
}

export interface ImportReport {
  /** Names of the notebooks that came across, in order. */
  imported: string[];
  /** Notebooks that did not come across, with the reason to show as is. */
  failed: Array<{ notebook: string; message: string }>;
  sections: number;
  pages: number;
  pictures: number;
  warnings: WarningGroup[];
  /** Ids of the notebooks created, in order. */
  notebookIds: string[];
}

/** Parses one notebook's files into an import tree; `onFile` is called as each section file is read. */
export type ParseNotebook = (source: ImportSource, onFile: (path: string) => void) => Promise<ImportedNotebook>;

/** Where an import writes. `flush` resolves once every write so far is stored, and rejects with a message to show as is. */
export interface ImportSink extends DocSink {
  flush(): Promise<void>;
}

/** Imports each source in turn and resolves with the report once all of it is stored; rejects only when storing fails. */
export async function importNotebooks(
  sources: ImportSource[],
  sink: ImportSink,
  parse: ParseNotebook,
  onProgress: (progress: ImportProgress) => void,
): Promise<ImportReport> {
  const report: ImportReport = { imported: [], failed: [], sections: 0, pages: 0, pictures: 0, warnings: [], notebookIds: [] };
  const warnings: string[] = [];
  for (const source of sources) {
    let tree: ImportedNotebook;
    try {
      tree = await parse(source, (path) => onProgress({ kind: 'reading', notebook: source.notebookName, path }));
    } catch (error) {
      report.failed.push({ notebook: source.notebookName, message: plainError(error as Error) });
      continue;
    }
    const pagesTotal = countPages(tree.children);
    let pagesDone = 0;
    const counting: DocSink = {
      getDoc: (docId) => {
        if (docId.startsWith('pg:')) onProgress({ kind: 'writing', notebook: source.notebookName, pagesDone: pagesDone++, pagesTotal });
        return sink.getDoc(docId);
      },
      putBlob: (bytes, mime) => sink.putBlob(bytes, mime),
    };
    let summary: ImportSummary;
    try {
      summary = await importTree(tree, counting);
    } catch (error) {
      // The model's message already says where the partly imported notebook went.
      report.failed.push({ notebook: source.notebookName, message: (error as Error).message });
      continue;
    }
    report.imported.push(source.notebookName);
    report.sections += summary.sections;
    report.pages += summary.pages;
    report.pictures += summary.blobs;
    report.notebookIds.push(summary.notebookId);
    warnings.push(...summary.warnings);
  }
  report.warnings = groupWarnings(warnings);
  onProgress({ kind: 'saving' });
  await sink.flush();
  return report;
}

function countPages(children: ImportedNotebook['children']): number {
  return children.reduce((n, c) => n + (c.kind === 'section' ? c.pages.length : countPages(c.children)), 0);
}

/**
 * Warnings come as "Section / Page title: what happened". They are grouped by
 * what happened, with numbers ignored so "3 ink strokes" and "5 ink strokes"
 * count together; the most frequent come first.
 */
export function groupWarnings(warnings: string[]): WarningGroup[] {
  const groups = new Map<string, WarningGroup>();
  for (const warning of warnings) {
    const match = /^(.*? \/ .*?): (.*)$/s.exec(warning);
    const place = match ? match[1]! : '';
    const message = plainWarning(match ? match[2]! : warning);
    const key = message.replace(/\d+/g, '#');
    let group = groups.get(key);
    if (!group) {
      group = { message, count: 0, places: [] };
      groups.set(key, group);
    }
    group.count++;
    if (place && group.places.length < 3) group.places.push(place.replace(/ \/ $/, ' / (untitled page)'));
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || a.message.localeCompare(b.message));
}

/**
 * The reader's messages for a section it could not read, as plain sentences.
 * `readNotebookFolderLazily` turns its typed errors into these warning texts,
 * so they are recognised by the error messages they carry.
 */
export function plainWarning(message: string): string {
  if (!message.startsWith('This section could not be imported')) return message;
  if (message.includes('password-protected')) return 'A password-protected section was skipped. Remove its password in OneNote, then import it again.';
  if (message.includes('packaging OneDrive downloads use')) {
    return 'A section downloaded from OneDrive was skipped. Open the notebook in OneNote on this computer and import its local backup instead.';
  }
  if (message.includes('Not a OneNote section') || message.includes('Not a section')) return 'A file that is not a OneNote section was skipped.';
  return 'A damaged section file was skipped.';
}

/** The plain message for an error thrown while importing, by the reader's error class name. */
export function plainError(error: { name?: string; message: string }): string {
  switch (error.name) {
    case 'EncryptedSectionError':
      return 'This section is password-protected. Remove its password in OneNote, then import it again.';
    case 'UnsupportedPackagingError':
      return 'This section came from OneDrive in a form that can’t be read yet. Import the local backup instead.';
    case 'NotOneNoteFileError':
      return 'This isn’t a OneNote section file.';
    case 'DamagedFileError':
      return 'This section file is damaged and can’t be read.';
    case NOT_SAVED_ERROR:
      return error.message;
    default:
      return `The import stopped: ${error.message}`;
  }
}

const NOT_SAVED_ERROR = 'ImportNotSavedError';

/**
 * An ImportSink over the sync client. Each page doc is released when the next
 * one opens; `close` releases the rest. `flush` rejects with the store's own
 * message when the device refuses the writes.
 */
export function clientDocSink(client: SyncClient): ImportSink & { close(): void } {
  const opened = new Map<string, Promise<Y.Doc>>();
  const release = (docId: string) => {
    const doc = opened.get(docId);
    opened.delete(docId);
    void doc?.then(() => client.releaseDoc(docId), () => undefined);
  };
  return {
    getDoc(docId) {
      // importTree fills one page at a time, so opening a page means every earlier one is written.
      if (docId.startsWith('pg:')) for (const id of [...opened.keys()]) if (id.startsWith('pg:') && id !== docId) release(id);
      let doc = opened.get(docId);
      if (!doc) {
        doc = client.openDoc(docId);
        opened.set(docId, doc);
      }
      return doc;
    },
    putBlob: (bytes) => client.putBlob(bytes),
    async flush() {
      try {
        await client.flush();
      } catch (error) {
        const stored = client.status.lastError;
        const reason = stored?.kind === 'store' ? stored.message : (error as Error).message;
        throw Object.assign(new Error(`The import couldn’t be saved on this device: ${reason}`), { name: NOT_SAVED_ERROR });
      }
    },
    close() {
      for (const docId of [...opened.keys()]) release(docId);
    },
  };
}

/** Parsing in a Web Worker; file bytes are transferred in, the tree's bytes transferred back. */
export const parseInWorker: ParseNotebook = (source, onFile) =>
  new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL('./parse-worker.ts', import.meta.url), { type: 'module' });
    } catch {
      parseOnMainThread(source, onFile).then(resolve, reject);
      return;
    }
    const byPath = new Map(source.files.map((f) => [f.path, f]));
    worker.onmessage = async (event: MessageEvent<WorkerReply>) => {
      const reply = event.data;
      if (reply.type === 'need') {
        onFile(reply.path);
        try {
          const bytes = await byPath.get(reply.path)!.read();
          worker.postMessage({ type: 'file', path: reply.path, bytes }, bytes.buffer instanceof ArrayBuffer ? [bytes.buffer] : []);
        } catch (error) {
          worker.postMessage({ type: 'file-error', path: reply.path, message: String(error) });
        }
      } else if (reply.type === 'done') {
        worker.terminate();
        resolve(reply.notebook);
      } else {
        worker.terminate();
        reject(Object.assign(new Error(reply.message), { name: reply.name }));
      }
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(event.message || 'The import worker stopped'));
    };
    worker.postMessage({ type: 'read', name: source.notebookName, paths: source.files.map((f) => f.path) });
  });

/** The same parse on the main thread, one file at a time, for where workers are unavailable. */
export const parseOnMainThread: ParseNotebook = (source, onFile) =>
  readNotebookFolderLazily(
    source.files.map((f) => ({
      path: f.path,
      read: async () => {
        onFile(f.path);
        await new Promise((r) => setTimeout(r, 0));
        return f.read();
      },
    })),
    { name: source.notebookName },
  );

export type WorkerRequest =
  | { type: 'read'; name: string; paths: string[] }
  | { type: 'file'; path: string; bytes: Uint8Array }
  | { type: 'file-error'; path: string; message: string };

export type WorkerReply =
  | { type: 'need'; path: string }
  | { type: 'done'; notebook: ImportedNotebook }
  | { type: 'failed'; name: string; message: string };
