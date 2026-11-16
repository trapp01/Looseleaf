/**
 * Plans a mirror: from the docs and the previous mirror manifest, the page
 * files to write, the asset files to copy, the paths to remove and the next
 * manifest. It reads through `DocSource` and touches no disk; a host applies
 * the plan. Folder and file names come from the export layout, and each page
 * file is YAML front matter followed by the page's Markdown export.
 */
import { strToU8 } from 'fflate';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { LIBRARY_DOC_ID, notebookDocId, pageDocId } from '../ids.js';
import { listNotebooks } from '../library.js';
import { readTree } from '../notebook.js';
import { readPage } from '../page.js';
import { blobHashes, type DocSource, type ExportFile, type PageForExport } from '../export/bundle.js';
import { layoutChildren, notebookFolderName } from '../export/layout.js';
import { pageToMarkdown } from '../export/markdown.js';
import { NameAllocator } from '../export/names.js';
import {
  isMirrorBlobHash,
  mirrorOwnedPaths,
  MIRROR_ASSETS_FOLDER,
  type MirrorManifest,
  type MirrorPage,
} from './manifest.js';

export interface MirrorPlanInput {
  source: DocSource;
  /** The manifest the mirror holds now, or null when it has none or it did not parse. */
  previous: MirrorManifest | null;
  /** Ids of pages whose page doc changed since the previous manifest. */
  changedPages: Iterable<string>;
  /** Renders every page, as with no previous manifest, but still removes what the previous one lists. */
  checkEverything: boolean;
}

/** An asset file to copy from the blob named `hash`. */
export interface MirrorAssetWrite {
  path: string;
  hash: string;
}

export interface MirrorPlan {
  /** Page files whose bytes differ from what the previous manifest records at that path. */
  writes: ExportFile[];
  /** Asset files no page in the previous manifest linked to. */
  assets: MirrorAssetWrite[];
  /**
   * Paths the previous manifest lists and the next one does not. A host
   * applies these before the writes, so a case-only rename works on a
   * case-insensitive file system, and writes the manifest last.
   */
  removals: string[];
  manifest: MirrorManifest;
  /** Pages whose doc could not be read. Each keeps its previous entry, if it had one. */
  failures: Array<{ pageId: string; error: unknown }>;
}

/**
 * Renders the pages that are new, named in `changedPages`, or whose path,
 * title, notebook name or section names differ from the previous manifest;
 * every other page keeps its entry and its doc is not read. Reads of the
 * library or a notebook doc that fail reject the whole plan.
 */
export async function planMirror(input: MirrorPlanInput): Promise<MirrorPlan> {
  const { source, previous } = input;
  const renderAll = input.checkEverything || previous === null;
  const changed = new Set(input.changedPages);
  const previousById = new Map(previous?.pages.map((page) => [page.id, page]));
  const previousHashByPath = new Map(previous?.pages.map((page) => [page.path, page.hash]));
  const blobPresence = new Map<string, Promise<boolean>>();
  const hasBlob = (hash: string): Promise<boolean> => {
    let present = blobPresence.get(hash);
    if (!present) {
      present = isMirrorBlobHash(hash)
        ? (source.hasBlob?.(hash) ?? source.getBlob(hash).then((bytes) => bytes !== null)).catch(() => false)
        : Promise.resolve(false);
      blobPresence.set(hash, present);
    }
    return present;
  };

  const pages: MirrorPage[] = [];
  const keptAfterFailure = new Set<MirrorPage>();
  const writes: ExportFile[] = [];
  const failures: MirrorPlan['failures'] = [];
  const notebookNames = new NameAllocator();
  for (const notebook of listNotebooks(await source.getDoc(LIBRARY_DOC_ID))) {
    const folder = notebookFolderName(notebook.name, notebookNames);
    const tree = readTree(await source.getDoc(notebookDocId(notebook.id)));
    for (const item of layoutChildren(tree.children, [folder], new NameAllocator(), '.md')) {
      if (item.kind !== 'page') continue;
      const entry = {
        id: item.page.id,
        notebookId: notebook.id,
        notebook: notebook.name,
        sectionId: item.sectionId,
        section: item.sectionNames,
        title: item.page.title,
        level: item.page.level,
        path: [...item.folder, item.fileName].join('/'),
      };
      const before = previousById.get(entry.id);
      const unchanged =
        !renderAll &&
        before !== undefined &&
        !changed.has(entry.id) &&
        before.path === entry.path &&
        before.title === entry.title &&
        before.notebook === entry.notebook &&
        sameStrings(before.section, entry.section);
      if (unchanged) {
        pages.push({ ...entry, hash: before.hash, assets: before.assets, missingBlobs: before.missingBlobs });
        continue;
      }
      let rendered: RenderedPage;
      try {
        const snapshot = readPage(await source.getDoc(pageDocId(entry.id)));
        rendered = await renderPage({ ...item.page, snapshot, blobs: new Map() }, entry, item.folder.length, hasBlob);
      } catch (error) {
        failures.push({ pageId: entry.id, error });
        if (before !== undefined) {
          pages.push(before);
          keptAfterFailure.add(before);
        }
        continue;
      }
      pages.push({ ...entry, hash: rendered.hash, assets: rendered.assets, missingBlobs: rendered.missingBlobs });
      if (previousHashByPath.get(entry.path) !== rendered.hash) writes.push({ path: entry.path, data: rendered.data });
    }
  }

  // A page kept after a failed read gives up its old path when another page now has it.
  const takenPaths = new Set(pages.filter((p) => !keptAfterFailure.has(p)).map((p) => p.path.toLowerCase()));
  const manifest: MirrorManifest = {
    format: 'looseleaf-mirror',
    version: 1,
    pages: pages.filter((p) => !keptAfterFailure.has(p) || !takenPaths.has(p.path.toLowerCase())),
  };

  const previousPaths = previous === null ? new Set<string>() : mirrorOwnedPaths(previous);
  const nextPaths = mirrorOwnedPaths(manifest);
  const assetPrefix = `${MIRROR_ASSETS_FOLDER}/`;
  const assets: MirrorAssetWrite[] = [];
  for (const path of nextPaths) {
    if (path.startsWith(assetPrefix) && !previousPaths.has(path)) {
      assets.push({ path, hash: path.slice(assetPrefix.length, assetPrefix.length + 64) });
    }
  }
  const removals = [...previousPaths].filter((path) => !nextPaths.has(path));
  return { writes, assets, removals, manifest, failures };
}

interface RenderedPage {
  data: Uint8Array;
  hash: string;
  assets: string[];
  missingBlobs: string[];
}

/** Placeholder bytes that tell `pageToMarkdown` a blob is present; the host copies the real bytes. */
const PRESENT = new Uint8Array(0);

async function renderPage(
  page: PageForExport,
  entry: { id: string; notebook: string; section: string[] },
  depth: number,
  hasBlob: (hash: string) => Promise<boolean>,
): Promise<RenderedPage> {
  const missing: string[] = [];
  for (const hash of blobHashes(page.snapshot)) {
    if (await hasBlob(hash)) page.blobs.set(hash, PRESENT);
    else if (isMirrorBlobHash(hash)) missing.push(hash);
  }
  const { markdown, assets } = pageToMarkdown(page, '../'.repeat(depth) + MIRROR_ASSETS_FOLDER);
  const text =
    '---\n' +
    `id: ${yamlString(entry.id)}\n` +
    `notebook: ${yamlString(entry.notebook)}\n` +
    `section: ${yamlString(entry.section.join(' / '))}\n` +
    '---\n\n' +
    markdown;
  const data = strToU8(text);
  return { data, hash: bytesToHex(sha256(data)), assets: [...assets.keys()].sort(), missingBlobs: missing.sort() };
}

/**
 * A double-quoted YAML scalar. JSON's string form is one, once the characters
 * YAML does not allow unescaped (C1 controls, line and paragraph separators,
 * byte order marks) are escaped too.
 */
function yamlString(value: string): string {
  return JSON.stringify(value).replace(
    /[\u007f-\u009f\u2028\u2029\ufeff\ufffe\uffff]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

function sameStrings(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}
