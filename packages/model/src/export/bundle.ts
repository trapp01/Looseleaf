/**
 * Export entry points: one page to a list of files, or a section, notebook or
 * the whole library to a zip that mirrors the tree as folders. Exports read
 * docs and blobs through `DocSource` and never change a doc. A missing blob
 * becomes a placeholder in the output; it never fails the export.
 */
import { zipSync, strToU8 } from 'fflate';
import type * as Y from 'yjs';
import { LIBRARY_DOC_ID, notebookDocId, pageDocId } from '../ids.js';
import { getNotebook, listNotebooks } from '../library.js';
import { getNode, livePages, readTree, type PageEntry, type PageLevel, type TreeChild } from '../notebook.js';
import { readPage, type PageSnapshot } from '../page.js';
import type { JSONContent } from '../rich-text.js';
import { pageToHtml } from './html.js';
import { pageToJson } from './json.js';
import { pageToMarkdown } from './markdown.js';
import { layoutChildren, notebookFolderName, pageFileName } from './layout.js';
import { NameAllocator } from './names.js';
import { pageToText } from './text.js';

/** Where exports read from. `getBlob` resolves null (or rejects) for a blob this device lacks. */
export interface DocSource {
  getDoc(docId: string): Promise<Y.Doc>;
  getBlob(hash: string): Promise<Uint8Array | null>;
  /** Whether the device holds the blob, without reading it. The mirror planner uses it when present. */
  hasBlob?(hash: string): Promise<boolean>;
}

export type ExportFormat = 'html' | 'markdown' | 'text' | 'json';

export type ExportScope =
  | { kind: 'library' }
  | { kind: 'notebook'; notebookId: string }
  | { kind: 'section'; notebookId: string; sectionId: string };

/** One output file. `path` uses `/` and is relative to the export's root. */
export interface ExportFile {
  path: string;
  data: Uint8Array;
}

/** Everything a format renderer needs for one page, with its blobs already fetched (null when missing). */
export interface PageForExport {
  id: string;
  title: string;
  level: PageLevel;
  createdAt: number;
  modifiedAt: number;
  snapshot: PageSnapshot;
  blobs: Map<string, Uint8Array | null>;
  /** Page titles by page id, for the text of card links. A card link to a page not here shows a stand-in. */
  pageTitles?: ReadonlyMap<string, string>;
}

const EXTENSIONS: Record<ExportFormat, string> = { html: '.html', markdown: '.md', text: '.txt', json: '.json' };

/**
 * One page as files: the page itself first, then for Markdown its
 * `assets/<file>` and for JSON its `blobs/<hash>`. Throws when the notebook
 * has no page with this id.
 */
export async function exportPage(
  source: DocSource,
  notebookId: string,
  pageId: string,
  format: ExportFormat,
): Promise<ExportFile[]> {
  const notebook = await source.getDoc(notebookDocId(notebookId));
  const node = getNode(notebook, pageId);
  if (node?.kind !== 'page') throw new Error(`Notebook ${notebookId} has no page ${pageId}`);
  const entry = { id: node.id, title: node.name, level: node.level, createdAt: node.createdAt, modifiedAt: node.modifiedAt };
  const exporter = new Exporter(source, format);
  exporter.learnTitles(notebook);
  await exporter.addPage(entry, [], pageFileName(entry.title, new NameAllocator(), EXTENSIONS[format]));
  return exporter.files();
}

/**
 * A section, a notebook or the whole library as a zip. Folders mirror the
 * tree (notebook, section groups, sections) with one file per page in page
 * order; deleted notebooks and nodes are left out. Markdown assets go in
 * `assets/` and JSON blobs in `blobs/` at the zip root. Throws when the
 * notebook or section in the scope does not exist or is deleted.
 */
export async function exportZip(source: DocSource, scope: ExportScope, format: ExportFormat): Promise<Uint8Array> {
  const exporter = new Exporter(source, format);
  const root = new NameAllocator();
  if (scope.kind === 'library') {
    for (const notebook of listNotebooks(await source.getDoc(LIBRARY_DOC_ID))) {
      await exporter.addNotebook(notebook.id, notebook.name, root);
    }
  } else {
    const notebook = getNotebook(await source.getDoc(LIBRARY_DOC_ID), scope.notebookId);
    if (!notebook || notebook.deletedAt !== null) throw new Error(`Notebook ${scope.notebookId} is not in the library`);
    if (scope.kind === 'notebook') {
      await exporter.addNotebook(notebook.id, notebook.name, root);
    } else {
      const notebookDoc = await source.getDoc(notebookDocId(scope.notebookId));
      exporter.learnTitles(notebookDoc);
      const tree = readTree(notebookDoc);
      const section = findSection(tree.children, scope.sectionId);
      if (!section) throw new Error(`Notebook ${scope.notebookId} has no section ${scope.sectionId}`);
      await exporter.addChildren([section], [], root);
    }
  }
  const zippable: Record<string, Uint8Array> = {};
  for (const file of exporter.files()) zippable[file.path] = file.data;
  return zipSync(zippable);
}

function findSection(children: TreeChild[], id: string): TreeChild | undefined {
  for (const child of children) {
    if (child.id === id && child.kind === 'section') return child;
    if (child.kind === 'group') {
      const found = findSection(child.children, id);
      if (found) return found;
    }
  }
  return undefined;
}

class Exporter {
  private readonly output = new Map<string, Uint8Array>();
  private readonly blobCache = new Map<string, Promise<Uint8Array | null>>();
  private readonly pageTitles = new Map<string, string>();

  constructor(
    private readonly source: DocSource,
    private readonly format: ExportFormat,
  ) {}

  files(): ExportFile[] {
    return [...this.output].map(([path, data]) => ({ path, data }));
  }

  /** Adds a notebook's page titles to those card links show. */
  learnTitles(notebook: Y.Doc): void {
    for (const [id, page] of livePages(notebook)) this.pageTitles.set(id, page.title);
  }

  async addNotebook(notebookId: string, name: string, names: NameAllocator): Promise<void> {
    const folder = notebookFolderName(name, names);
    this.output.set(`${folder}/`, new Uint8Array(0));
    const notebook = await this.source.getDoc(notebookDocId(notebookId));
    this.learnTitles(notebook);
    const tree = readTree(notebook);
    await this.addChildren(tree.children, [folder], new NameAllocator());
  }

  async addChildren(children: TreeChild[], folder: string[], names: NameAllocator): Promise<void> {
    for (const item of layoutChildren(children, folder, names, EXTENSIONS[this.format])) {
      if (item.kind === 'folder') this.output.set(`${item.path.join('/')}/`, new Uint8Array(0));
      else await this.addPage(item.page, item.folder, item.fileName);
    }
  }

  async addPage(entry: PageEntry, folder: string[], fileName: string): Promise<void> {
    const snapshot = readPage(await this.source.getDoc(pageDocId(entry.id)));
    const blobs = new Map<string, Uint8Array | null>();
    for (const hash of blobHashes(snapshot)) blobs.set(hash, await this.blob(hash));
    const page: PageForExport = { ...entry, snapshot, blobs, pageTitles: this.pageTitles };
    const path = [...folder, fileName].join('/');
    const toRoot = '../'.repeat(folder.length);
    switch (this.format) {
      case 'html':
        this.output.set(path, strToU8(pageToHtml(page)));
        break;
      case 'text':
        this.output.set(path, strToU8(pageToText(page)));
        break;
      case 'markdown': {
        const { markdown, assets } = pageToMarkdown(page, `${toRoot}assets`);
        this.output.set(path, strToU8(markdown));
        for (const [name, data] of assets) this.output.set(`assets/${name}`, data);
        break;
      }
      case 'json':
        this.output.set(path, strToU8(JSON.stringify(pageToJson(page), null, 2) + '\n'));
        for (const [hash, data] of blobs) if (data) this.output.set(`blobs/${hash}`, data);
        break;
    }
  }

  private blob(hash: string): Promise<Uint8Array | null> {
    let pending = this.blobCache.get(hash);
    if (!pending) {
      pending = this.source.getBlob(hash).catch(() => null);
      this.blobCache.set(hash, pending);
    }
    return pending;
  }
}

/** Every blob a page references: image and file containers and pictures inside text bodies. */
export function blobHashes(snapshot: PageSnapshot): Set<string> {
  const hashes = new Set<string>();
  const walk = (node: JSONContent) => {
    if (node.type === 'image' && typeof node.attrs?.blob === 'string') hashes.add(node.attrs.blob);
    node.content?.forEach(walk);
  };
  for (const c of snapshot.containers) {
    if (c.kind === 'text') walk(c.body);
    else if (c.blob) hashes.add(c.blob);
  }
  return hashes;
}
