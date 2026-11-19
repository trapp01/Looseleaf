/**
 * Writes notes for the MCP endpoint: a new notebook with its first sections,
 * a new page with a Markdown body, or Markdown added to the end of an
 * existing page. Every read and write goes
 * through `Hub.withDoc`, so a write is stored and relayed to connected clients
 * like a client's edit, and the mirror picks it up from the store after its
 * delay. Besides `mirror.ts`, this is the only server file that reads or
 * writes what is inside a doc, and it does so through `@looseleaf/model`. It
 * knows nothing about MCP; the wording of answers lives in `mcp-tools.ts`.
 */
import {
  LIBRARY_DOC_ID,
  appendToPage,
  createNotebook,
  createPage,
  createSection,
  getNode,
  listNotebooks,
  markdownToBody,
  notebookDocId,
  pageDocId,
  readTree,
  touchNode,
  type NodeEntry,
  type NotebookEntry,
  type TreeChild,
} from '@looseleaf/model';
import type { Hub } from './hub.js';

/** The page a write went to, with the names a person would recognise it by. */
export interface WrittenPage {
  id: string;
  title: string;
  notebook: { id: string; name: string };
  /** `path` is the names of the groups above the section and the section itself, outermost first. */
  section: { id: string; path: string[] };
}

export type WriteOutcome =
  | { kind: 'written'; page: WrittenPage; warnings: string[] }
  /** No notebook has a node with the id, or the node is not the kind asked for. */
  | { kind: 'no-section' | 'no-page' }
  /** The node, or a section, group or notebook above it, is in Deleted notes. */
  | { kind: 'section-deleted' | 'page-deleted' };

export type NotebookOutcome =
  | { kind: 'created'; notebook: { id: string; name: string }; sections: Array<{ id: string; name: string }> }
  /** A live notebook already has the name, ignoring case. */
  | { kind: 'name-taken'; name: string };

/** Where a live section or page sits in its notebook's tree. */
interface Place {
  sectionId: string;
  path: string[];
  /** The page's title; null for a section. */
  title: string | null;
}

export class NotesWriter {
  constructor(private readonly hub: Hub) {}

  /**
   * Adds a notebook at the end of the library, with top-level sections of the
   * given names in order. A name a live notebook already has is refused, so
   * a board or a caller can name the notebook by name.
   */
  async createNotebook(input: { name: string; sections: string[] }): Promise<NotebookOutcome> {
    const made = await this.hub.withDoc(LIBRARY_DOC_ID, (doc) => {
      const taken = listNotebooks(doc).find((notebook) => notebook.name.toLowerCase() === input.name.toLowerCase());
      return taken === undefined ? createNotebook(doc, { name: input.name }) : { taken: taken.name };
    });
    if (typeof made !== 'string') return { kind: 'name-taken', name: made.taken };
    const sections = await this.hub.withDoc(notebookDocId(made), (doc) =>
      input.sections.map((name) => ({ id: createSection(doc, { name, parent: null }), name })),
    );
    return { kind: 'created', notebook: { id: made, name: input.name }, sections };
  }

  /**
   * Adds a top-level page at the end of a section. With Markdown the page gets
   * one text container holding it; without, the page starts empty, as a new
   * page in the web client does.
   */
  async createPage(input: { sectionId: string; title: string; markdown?: string }): Promise<WriteOutcome> {
    const converted = input.markdown === undefined ? null : await markdownToBody(input.markdown);
    const found = await this.find(input.sectionId);
    if (found === null || found.node.kind !== 'section') return { kind: 'no-section' };
    if (found.place === null) return { kind: 'section-deleted' };
    // The section is checked again inside the write, in case it was deleted since it was found.
    const pageId = await this.hub.withDoc(notebookDocId(found.notebook.id), (doc) =>
      placeIn(readTree(doc).children, input.sectionId) === null ? null : createPage(doc, { section: input.sectionId, title: input.title }),
    );
    if (pageId === null) return { kind: 'section-deleted' };
    if (converted !== null) await this.hub.withDoc(pageDocId(pageId), (doc) => appendToPage(doc, converted.body));
    return {
      kind: 'written',
      page: writtenPage(found.notebook, { ...found.place, title: input.title }, pageId),
      warnings: converted?.warnings ?? [],
    };
  }

  /** Adds Markdown after the end of a page's last text container, and marks the page modified now. */
  async appendToPage(input: { pageId: string; markdown: string }): Promise<WriteOutcome> {
    const { body, warnings } = await markdownToBody(input.markdown);
    const found = await this.find(input.pageId);
    if (found === null || found.node.kind !== 'page') return { kind: 'no-page' };
    if (found.place === null) return { kind: 'page-deleted' };
    await this.hub.withDoc(pageDocId(input.pageId), (doc) => appendToPage(doc, body));
    await this.hub.withDoc(notebookDocId(found.notebook.id), (doc) => touchNode(doc, input.pageId));
    return { kind: 'written', page: writtenPage(found.notebook, found.place, input.pageId), warnings };
  }

  /**
   * The notebook holding the node with this id, deleted or not, the node, and
   * its place when it and everything above it are live. Null when no notebook has it.
   */
  private async find(id: string): Promise<{ notebook: NotebookEntry; node: NodeEntry; place: Place | null } | null> {
    const notebooks = await this.hub.withDoc(LIBRARY_DOC_ID, (doc) => listNotebooks(doc, { includeDeleted: true }));
    for (const notebook of notebooks) {
      const found = await this.hub.withDoc(notebookDocId(notebook.id), (doc) => {
        const node = getNode(doc, id);
        return node === null ? null : { node, place: notebook.deletedAt === null ? placeIn(readTree(doc).children, id) : null };
      });
      if (found !== null) return { notebook, ...found };
    }
    return null;
  }
}

/** The place of a live section or page in a tree, or null when the tree does not show it. */
function placeIn(children: TreeChild[], id: string, path: string[] = []): Place | null {
  for (const child of children) {
    const childPath = [...path, child.name];
    if (child.kind === 'group') {
      const place = placeIn(child.children, id, childPath);
      if (place !== null) return place;
      continue;
    }
    if (child.id === id) return { sectionId: child.id, path: childPath, title: null };
    const page = child.pages.find((candidate) => candidate.id === id);
    if (page !== undefined) return { sectionId: child.id, path: childPath, title: page.title };
  }
  return null;
}

function writtenPage(notebook: NotebookEntry, place: Place, pageId: string): WrittenPage {
  return {
    id: pageId,
    title: place.title ?? '',
    notebook: { id: notebook.id, name: notebook.name },
    section: { id: place.sectionId, path: place.path },
  };
}
