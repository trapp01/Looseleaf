/**
 * One `.one` section file to one import-tree section ([MS-ONE] 2.1.10, 2.1.14,
 * 2.2.17–2.2.19, 2.2.30): pages in page-series order with their title, level,
 * times and content. Only each page's current version is read; conflict pages
 * and version history live in other object spaces and are never visited.
 */
import type { ImportedPage, ImportedSection } from '../../model/src/import-tree.js';
import { FormatError, type ExGuid } from './bytes.js';
import {
  DamagedFileError,
  EncryptedSectionError,
  NotOneNoteFileError,
  UnsupportedPackagingError,
} from './errors.js';
import {
  GUID_FILE_FORMAT_PACKAGE,
  GUID_FILE_FORMAT_REVISION_STORE,
  GUID_FILE_TYPE_ONE,
  GUID_FILE_TYPE_ONETOC2,
  readHeaderGuids,
} from './file-node-list.js';
import { Jcid } from './jcids.js';
import { readPageContent, type PageContentContext } from './page-content.js';
import { PropertyId as P } from './property-ids.js';
import type { PropertySet } from './property-set.js';
import { openRevisionStore, RootRole, type ObjectSpace, type RevisionStore } from './revision-store.js';
import { colorRefToHex, readParagraph } from './rich-text.js';

/**
 * Reads one section file. Pages come in the section's order, each with its
 * title, level (0–2), times, containers and warnings. Throws
 * NotOneNoteFileError, UnsupportedPackagingError, EncryptedSectionError or
 * DamagedFileError when the file as a whole cannot be read; a problem inside
 * one page becomes a warning on that page.
 */
export function readOneSection(bytes: Uint8Array, options: { name: string }): ImportedSection {
  const store = openSectionStore(bytes, options.name);
  const space = store.space(store.rootSpaceId);
  if (!space) throw new DamagedFileError('The section object space cannot be read', options.name, store.damagedSpaces.get(store.rootSpaceId) ?? 'missing');
  if (space.encrypted) throw new EncryptedSectionError('The section is password-protected', options.name, 'encrypted object space');
  const sectionNode = space.root(RootRole.DefaultContent);
  if (!sectionNode || sectionNode.jcid !== Jcid.SectionNode) {
    throw new DamagedFileError('The section has no section node', options.name, sectionNode ? `JCID 0x${sectionNode.jcid.toString(16)}` : 'no root object');
  }

  const meta = space.root(RootRole.Metadata)?.props;
  const section: ImportedSection = { kind: 'section', name: meta?.string(P.SectionDisplayName) || options.name, pages: [] };
  // NotebookColor holds 0x00bbggrr like a COLORREF; 0xFFFFFFFF means no colour.
  const color = colorRefToHex(meta?.uint(P.NotebookColor));
  if (color) section.color = color;

  for (const seriesId of sectionNode.props.objectIds(P.ElementChildNodes)) {
    const series = space.object(seriesId);
    if (!series || series.jcid !== Jcid.PageSeriesNode) continue;
    for (const pageSpaceId of series.props.spaceIds(P.ChildGraphSpaceElementNodes)) {
      const page = readPage(store, pageSpaceId);
      if (page) section.pages.push(page);
    }
  }
  return section;
}

/** Checks the header GUIDs ([MS-ONESTORE] 2.3.1, 2.8.1) and opens the revision store. */
function openSectionStore(bytes: Uint8Array, fileName: string): RevisionStore {
  const guids = readHeaderGuids(bytes);
  if (!guids) throw new NotOneNoteFileError('Not a OneNote section', fileName, `only ${bytes.length} bytes`);
  if (guids.fileType === GUID_FILE_TYPE_ONETOC2) {
    throw new NotOneNoteFileError('Not a section', fileName, 'a notebook table of contents (.onetoc2)');
  }
  if (guids.fileType !== GUID_FILE_TYPE_ONE) {
    throw new NotOneNoteFileError('Not a OneNote section', fileName, `file type {${guids.fileType}}`);
  }
  if (guids.fileFormat === GUID_FILE_FORMAT_PACKAGE) {
    throw new UnsupportedPackagingError(
      'This section is in the packaging OneDrive downloads use, which this reader does not support yet',
      fileName,
      `file format {${guids.fileFormat}}`,
    );
  }
  if (guids.fileFormat !== GUID_FILE_FORMAT_REVISION_STORE) {
    throw new NotOneNoteFileError('Not a OneNote section', fileName, `file format {${guids.fileFormat}}`);
  }
  try {
    return openRevisionStore(bytes);
  } catch (e) {
    if (e instanceof FormatError) throw new DamagedFileError('The file structure cannot be read', fileName, e.message);
    throw e;
  }
}

function warningCollector(): { warn(message: string): void; list(): string[] } {
  const counts = new Map<string, number>();
  return {
    warn: (message) => counts.set(message, (counts.get(message) ?? 0) + 1),
    list: () => [...counts].map(([message, n]) => (n > 1 ? `${message} (${n} times)` : message)),
  };
}

/** One page object space (2.1.10) as a page; undefined for pages marked deleted. */
function readPage(store: RevisionStore, spaceId: ExGuid): ImportedPage | undefined {
  const warnings = warningCollector();
  const page: ImportedPage = { title: '', level: 0, containers: [], strokes: [], warnings: [] };
  const space = store.space(spaceId);
  if (!space || space.encrypted) {
    page.warnings.push(space ? 'Password-protected page not imported' : 'This page could not be read');
    return page;
  }
  const meta = space.root(RootRole.Metadata)?.props;
  if (meta && isMarkedDeleted(meta)) return undefined;
  const manifest = space.root(RootRole.DefaultContent);
  const pageNode = manifest?.props
    .objectIds(P.ContentChildNodes)
    .map((id) => space.object(id))
    .find((node) => node?.jcid === Jcid.PageNode);

  // PageLevel (2.3.74) is 1–3, with 1 for a top page.
  const level = (meta?.int32(P.PageLevel) ?? 1) - 1;
  page.level = level >= 2 ? 2 : level <= 0 ? 0 : 1;
  const created = fileTimeToMs(meta?.uint(P.TopologyCreationTimeStamp));
  if (created !== undefined) page.createdAt = created;
  const modified = latestModification(space, pageNode?.props);
  if (modified !== undefined) page.modifiedAt = modified;

  if (!pageNode) {
    page.title = meta?.string(P.CachedTitleString) ?? '';
    page.warnings.push('This page has no content node and was imported empty');
    return page;
  }
  const ctx: PageContentContext = { object: (id) => space.object(id), warn: warnings.warn, visited: new Set() };
  try {
    page.title = readTitle(pageNode.props, ctx) || meta?.string(P.CachedTitleString) || pageNode.props.string(P.CachedTitleStringFromPage) || '';
    const content = readPageContent(pageNode, ctx);
    page.containers = content.containers;
    if (content.inkStrokes > 0) warnings.warn(`Ink drawing not imported (${content.inkStrokes} strokes)`);
  } catch (e) {
    if (!(e instanceof FormatError)) throw e;
    warnings.warn(`Part of this page could not be read: ${e.message}`);
  }
  page.warnings = warnings.list();
  return page;
}

/** IsDeletedGraphSpaceContent (2.3.73) is a Boolean, though the property table lists it with length-prefixed data. */
function isMarkedDeleted(meta: PropertySet): boolean {
  const flag = meta.bool(P.IsDeletedGraphSpaceContent);
  if (flag !== undefined) return flag;
  return meta.bytes(P.IsDeletedGraphSpaceContent)?.some((b) => b !== 0) ?? false;
}

/** The text of the title outline (2.1.16): every paragraph of the outline marked IsTitleText. */
function readTitle(pageProps: PropertySet, ctx: PageContentContext): string {
  const parts: string[] = [];
  for (const titleId of pageProps.objectIds(P.StructureElementChildNodes)) {
    const titleNode = ctx.object(titleId);
    if (titleNode?.jcid !== Jcid.TitleNode) continue;
    for (const outlineId of titleNode.props.objectIds(P.ElementChildNodes)) {
      const outline = ctx.object(outlineId);
      if (!outline?.props.bool(P.IsTitleText)) continue;
      const pending = [...outline.props.objectIds(P.ElementChildNodes)];
      const seen = new Set<ExGuid>();
      while (pending.length > 0) {
        const id = pending.shift()!;
        if (seen.has(id)) continue;
        seen.add(id);
        const element = ctx.object(id);
        if (!element) continue;
        pending.push(...element.props.objectIds(P.ElementChildNodes));
        for (const contentId of element.props.objectIds(P.ContentChildNodes)) {
          const content = ctx.object(contentId);
          if (content?.jcid !== Jcid.RichTextOENode) continue;
          const text = readParagraph(content, ctx).runs.map((run) => run.text).join('');
          if (text.trim()) parts.push(text.trim());
        }
      }
    }
  }
  return parts.join(' ');
}

/** The later of the revision's LastModifiedTimeStamp (2.2.39) and the page's LastModifiedTime. */
function latestModification(space: ObjectSpace, pageProps: PropertySet | undefined): number | undefined {
  const revision = fileTimeToMs(space.root(RootRole.VersionMetadata)?.props.uint(P.LastModifiedTimeStamp));
  const page = time32ToMs(pageProps?.uint(P.LastModifiedTime));
  if (revision === undefined) return page;
  if (page === undefined) return revision;
  return Math.max(revision, page);
}

const FILETIME_UNIX_EPOCH_MS = 11_644_473_600_000;
const TIME32_UNIX_EPOCH_S = 315_532_800;
// Later than this is not a real note time; it comes from an unset or damaged field.
const LATEST_PLAUSIBLE_MS = Date.UTC(2200, 0, 1);

/** A FILETIME ([MS-DTYP] 2.3.3, 100 ns ticks since 1601) as epoch ms. */
export function fileTimeToMs(ticks: number | undefined): number | undefined {
  if (!ticks) return undefined;
  const ms = Math.round(ticks / 10_000 - FILETIME_UNIX_EPOCH_MS);
  return ms > 0 && ms < LATEST_PLAUSIBLE_MS ? ms : undefined;
}

/** A Time32 ([MS-ONE] 2.3.1, seconds since 1980-01-01 UTC) as epoch ms. */
export function time32ToMs(seconds: number | undefined): number | undefined {
  if (!seconds) return undefined;
  const ms = (seconds + TIME32_UNIX_EPOCH_S) * 1000;
  return ms < LATEST_PLAUSIBLE_MS ? ms : undefined;
}
