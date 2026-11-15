/**
 * What an export choice turns into: which model export runs for each scope
 * and format, what the output file is called, and how it reaches the person
 * (the shell's save dialog, or a browser download or print). The dialog only
 * collects the choice; everything else is decided here.
 */
import { zipSync } from 'fflate';
import type * as Y from 'yjs';
import type { SyncClient } from '@looseleaf/sync';
import { exportPage, exportZip, type DocSource, type ExportFormat } from '@looseleaf/model';
import { shell } from '../shell-bridge.js';

export type ExportScopeChoice = 'page' | 'section' | 'notebook' | 'everything';
export type ExportFormatChoice = ExportFormat | 'pdf';

export interface ExportTarget {
  notebookId: string | null;
  sectionId: string | null;
  pageId: string | null;
  notebookName: string;
  sectionName: string;
  pageTitle: string;
}

export interface ExportRequest {
  scope: ExportScopeChoice;
  format: ExportFormatChoice;
  target: ExportTarget;
}

export type ExportResult =
  | { kind: 'file'; name: string; mime: string; bytes: Uint8Array }
  | { kind: 'print'; name: string };

export const FORMAT_LABELS: Record<ExportFormatChoice, string> = {
  html: 'HTML',
  markdown: 'Markdown',
  text: 'Plain text',
  json: 'JSON',
  pdf: 'PDF',
};

/** PDF comes from printing the open page, so it is offered for a single page only. */
export function formatsFor(scope: ExportScopeChoice): ExportFormatChoice[] {
  return scope === 'page' ? ['html', 'markdown', 'text', 'json', 'pdf'] : ['html', 'markdown', 'text', 'json'];
}

/** Scopes that have something to export for this target. */
export function scopesFor(target: ExportTarget): ExportScopeChoice[] {
  const scopes: ExportScopeChoice[] = [];
  if (target.pageId && target.notebookId) scopes.push('page');
  if (target.sectionId && target.notebookId) scopes.push('section');
  if (target.notebookId) scopes.push('notebook');
  scopes.push('everything');
  return scopes;
}

const MIME: Record<ExportFormat, string> = {
  html: 'text/html',
  markdown: 'text/markdown',
  text: 'text/plain',
  json: 'application/json',
};

export async function runExport(source: DocSource, request: ExportRequest): Promise<ExportResult> {
  const { scope, format, target } = request;
  const name = (base: string, fallback: string) => (base.trim() || fallback).replace(/[\\/:*?"<>|]+/g, '-');
  if (format === 'pdf') {
    if (scope !== 'page') throw new Error('PDF is available for a single page only');
    return { kind: 'print', name: `${name(target.pageTitle, 'Untitled page')}.pdf` };
  }
  const zip = (bytes: Uint8Array, base: string): ExportResult => ({ kind: 'file', name: `${base}.zip`, mime: 'application/zip', bytes });
  switch (scope) {
    case 'page': {
      const files = await exportPage(source, need(target.notebookId), need(target.pageId), format);
      const only = files.length === 1 ? files[0]! : null;
      if (only) return { kind: 'file', name: only.path, mime: MIME[format], bytes: only.data };
      return zip(zipSync(Object.fromEntries(files.map((f) => [f.path, f.data]))), name(target.pageTitle, 'Untitled page'));
    }
    case 'section':
      return zip(
        await exportZip(source, { kind: 'section', notebookId: need(target.notebookId), sectionId: need(target.sectionId) }, format),
        name(target.sectionName, 'Untitled section'),
      );
    case 'notebook':
      return zip(await exportZip(source, { kind: 'notebook', notebookId: need(target.notebookId) }, format), name(target.notebookName, 'Untitled notebook'));
    case 'everything':
      return zip(await exportZip(source, { kind: 'library' }, format), 'Looseleaf');
  }
}

function need(id: string | null): string {
  if (!id) throw new Error('Nothing is selected to export');
  return id;
}

/** A DocSource over the sync client. Call `close` when the export is done to release every doc it opened. */
export function clientDocSource(client: SyncClient): DocSource & { close(): void } {
  const opened = new Map<string, Promise<Y.Doc>>();
  return {
    getDoc(docId) {
      let doc = opened.get(docId);
      if (!doc) {
        doc = client.openDoc(docId);
        opened.set(docId, doc);
      }
      return doc;
    },
    getBlob: (hash) => client.getBlob(hash),
    close() {
      for (const [docId, doc] of opened) void doc.then(() => client.releaseDoc(docId), () => undefined);
      opened.clear();
    },
  };
}

/** Hands the result to the person: the shell's save dialog, else a download or the print dialog. Resolves false when cancelled. */
export async function deliverExport(result: ExportResult): Promise<boolean> {
  const bridge = shell();
  if (result.kind === 'print') {
    if (bridge) return bridge.savePdf(result.name);
    window.print();
    return true;
  }
  if (bridge) return bridge.saveFile(result.name, result.bytes);
  const url = URL.createObjectURL(new Blob([result.bytes as Uint8Array<ArrayBuffer>], { type: result.mime }));
  const link = document.createElement('a');
  link.href = url;
  link.download = result.name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return true;
}
