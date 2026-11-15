/**
 * A notebook doc (`nb:<id>`): the tree of section groups, sections and page
 * entries, stored as a flat map of nodes with parent pointers. Every read and
 * write of its Y.Map keys happens in this file. Readers repair what
 * concurrent edits can produce: a group parent cycle puts the groups in it at
 * the root, a group or section whose parent is gone sits at the root, and
 * page levels are clamped so a subpage always has a page above it.
 */
import * as Y from 'yjs';
import { colorForIndex, isColorName, type ColorName } from './colors.js';
import { newId } from './ids.js';
import { orderAt, ordersAt, sortByOrder } from './order.js';

export type NodeKind = 'group' | 'section' | 'page';
export type PageLevel = 0 | 1 | 2;

/** One node as stored. `color` is set for sections only, `level` matters for pages only. */
export interface NodeEntry {
  id: string;
  kind: NodeKind;
  /** A group's or section's parent group (null for the root); a page's section. */
  parent: string | null;
  name: string;
  order: string;
  color: ColorName | null;
  level: PageLevel;
  createdAt: number;
  modifiedAt: number;
  deletedAt: number | null;
}

export interface PageEntry {
  id: string;
  title: string;
  /** The level as displayed: never more than one deeper than the page above. */
  level: PageLevel;
  createdAt: number;
  modifiedAt: number;
}

export interface SectionEntry {
  kind: 'section';
  id: string;
  name: string;
  color: ColorName;
  createdAt: number;
  modifiedAt: number;
  pages: PageEntry[];
}

export interface GroupEntry {
  kind: 'group';
  id: string;
  name: string;
  createdAt: number;
  modifiedAt: number;
  children: TreeChild[];
}

export type TreeChild = GroupEntry | SectionEntry;

export interface NotebookTree {
  children: TreeChild[];
}

/** Where a node goes: its new parent and its position among the live siblings there (default: last). */
export interface Placement {
  parent: string | null;
  index?: number;
}

function nodesMap(doc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return doc.getMap('nodes');
}

function readEntry(id: string, map: Y.Map<unknown>): NodeEntry {
  const kind = map.get('kind') as NodeKind;
  const color = map.get('color');
  const level = map.get('level');
  return {
    id,
    kind,
    parent: (map.get('parent') as string | null | undefined) ?? null,
    name: String(map.get('name') ?? ''),
    order: String(map.get('order') ?? ''),
    color: kind === 'section' ? (isColorName(color) ? color : colorForIndex(0)) : null,
    level: level === 1 || level === 2 ? level : 0,
    createdAt: Number(map.get('createdAt') ?? 0),
    modifiedAt: Number(map.get('modifiedAt') ?? 0),
    deletedAt: (map.get('deletedAt') as number | null | undefined) ?? null,
  };
}

function getNodeMap(doc: Y.Doc, id: string): Y.Map<unknown> {
  const map = nodesMap(doc).get(id);
  if (!map) throw new Error(`Node ${id} is not in this notebook`);
  return map;
}

/** The structure of a notebook as readers see it, computed once per call. */
class Structure {
  readonly nodes = new Map<string, NodeEntry>();
  private readonly liveCache = new Map<string, boolean>();
  private children: Map<string | null, NodeEntry[]> | undefined;

  constructor(doc: Y.Doc) {
    nodesMap(doc).forEach((map, id) => this.nodes.set(id, readEntry(id, map)));
  }

  /**
   * The parent a reader places the node under: a group id or null for the
   * root, a section id for a page, or undefined for a page whose section is gone.
   */
  parentOf(node: NodeEntry): string | null | undefined {
    const parent = node.parent === null ? undefined : this.nodes.get(node.parent);
    if (node.kind === 'page') return parent?.kind === 'section' ? parent.id : undefined;
    if (parent?.kind !== 'group') return null;
    return node.kind === 'group' && this.inGroupCycle(node.id) ? null : parent.id;
  }

  private inGroupCycle(id: string): boolean {
    const seen = new Set<string>();
    let current = this.nodes.get(id);
    while (current?.kind === 'group' && current.parent !== null && !seen.has(current.id)) {
      seen.add(current.id);
      if (current.parent === id) return true;
      current = this.nodes.get(current.parent);
    }
    return false;
  }

  /** True when the node and every node above it are not deleted. */
  isLive(node: NodeEntry): boolean {
    let live = this.liveCache.get(node.id);
    if (live === undefined) {
      const parent = this.parentOf(node);
      const parentNode = parent == null ? undefined : this.nodes.get(parent);
      live = node.deletedAt === null && parent !== undefined && (!parentNode || this.isLive(parentNode));
      this.liveCache.set(node.id, live);
    }
    return live;
  }

  /** Live children of a parent, sorted. Pages under a section; groups and sections elsewhere. */
  childrenOf(parent: string | null, exceptId?: string): NodeEntry[] {
    const all = this.childIndex().get(parent) ?? [];
    return sortByOrder(all.filter((n) => n.id !== exceptId && this.isLive(n)));
  }

  /** Every node below `id` as readers place them, live or deleted, not including it. */
  descendantsOf(id: string): NodeEntry[] {
    const found: NodeEntry[] = [];
    const visit = (parent: string) => {
      for (const child of this.childIndex().get(parent) ?? []) {
        found.push(child);
        visit(child.id);
      }
    };
    visit(id);
    return found;
  }

  private childIndex(): Map<string | null, NodeEntry[]> {
    if (!this.children) {
      this.children = new Map();
      for (const n of this.nodes.values()) {
        const parent = this.parentOf(n);
        if (parent === undefined) continue;
        const list = this.children.get(parent) ?? [];
        list.push(n);
        this.children.set(parent, list);
      }
    }
    return this.children;
  }
}

/**
 * The live tree, sorted. Deleted nodes and everything under them are left
 * out; see `listDeletedNodes` for those.
 */
export function readTree(doc: Y.Doc): NotebookTree {
  const s = new Structure(doc);
  const build = (parent: string | null): TreeChild[] =>
    s.childrenOf(parent).map((n): TreeChild => {
      const base = { id: n.id, name: n.name, createdAt: n.createdAt, modifiedAt: n.modifiedAt };
      if (n.kind === 'group') return { kind: 'group', ...base, children: build(n.id) };
      return { kind: 'section', ...base, color: n.color!, pages: readPages(s, n.id) };
    });
  return { children: build(null) };
}

function readPages(s: Structure, sectionId: string): PageEntry[] {
  return displayedPages(s, sectionId).map(({ page: p, level }) => ({
    id: p.id,
    title: p.name,
    level,
    createdAt: p.createdAt,
    modifiedAt: p.modifiedAt,
  }));
}

/** A section's live pages in order, each with its level as displayed. */
function displayedPages(s: Structure, sectionId: string): Array<{ page: NodeEntry; level: PageLevel }> {
  let previous = -1;
  return s.childrenOf(sectionId).map((page) => {
    const level = Math.min(page.level, previous + 1) as PageLevel;
    previous = level;
    return { page, level };
  });
}

/**
 * A live page and its subpages: the pages after it with a deeper displayed
 * level, up to the next page at the same or a shallower level. A page that
 * is deleted or hidden is returned alone.
 */
function pageWithSubpages(s: Structure, page: NodeEntry): NodeEntry[] {
  if (!s.isLive(page)) return [page];
  const pages = displayedPages(s, page.parent!);
  const start = pages.findIndex((p) => p.page.id === page.id);
  const block = [page];
  for (let i = start + 1; i < pages.length && pages[i]!.level > pages[start]!.level; i++) block.push(pages[i]!.page);
  return block;
}

/** The node with this id as stored, deleted or not, or null when there is none. */
export function getNode(doc: Y.Doc, id: string): NodeEntry | null {
  const map = nodesMap(doc).get(id);
  return map ? readEntry(id, map) : null;
}

/**
 * Deleted notes: every node marked deleted, newest deletion first. Pages
 * inside a deleted section are not listed on their own; they come back with
 * the section.
 */
export function listDeletedNodes(doc: Y.Doc): NodeEntry[] {
  const deleted: NodeEntry[] = [];
  nodesMap(doc).forEach((map, id) => {
    const entry = readEntry(id, map);
    if (entry.deletedAt !== null) deleted.push(entry);
  });
  return deleted.sort((a, b) => b.deletedAt! - a.deletedAt! || (a.id < b.id ? -1 : 1));
}

function assertContainerParent(s: Structure, parent: string | null, what: string): void {
  if (parent === null) return;
  const node = s.nodes.get(parent);
  if (node?.kind !== 'group') throw new Error(`Cannot put ${what} under ${parent}: it is not a section group`);
}

function assertSection(s: Structure, parent: string | null, what: string): asserts parent is string {
  const node = parent === null ? undefined : s.nodes.get(parent);
  if (node?.kind !== 'section') throw new Error(`Cannot put ${what} under ${parent}: it is not a section`);
}

function insertNode(doc: Y.Doc, fields: Record<string, unknown>): string {
  const id = newId();
  doc.transact(() => {
    const map = new Y.Map<unknown>();
    nodesMap(doc).set(id, map);
    for (const [key, value] of Object.entries(fields)) map.set(key, value);
    map.set('deletedAt', null);
  });
  return id;
}

/** Adds a section group and returns its id. */
export function createGroup(doc: Y.Doc, input: { name: string } & Placement): string {
  const s = new Structure(doc);
  assertContainerParent(s, input.parent, 'a section group');
  const siblings = s.childrenOf(input.parent);
  const now = Date.now();
  return insertNode(doc, {
    kind: 'group',
    parent: input.parent,
    name: input.name,
    order: orderAt(siblings, input.index ?? siblings.length),
    createdAt: now,
    modifiedAt: now,
  });
}

/** Adds a section and returns its id. Without a colour it takes the next palette colour. */
export function createSection(doc: Y.Doc, input: { name: string; color?: ColorName } & Placement): string {
  const s = new Structure(doc);
  assertContainerParent(s, input.parent, 'a section');
  if (input.color !== undefined && !isColorName(input.color)) {
    throw new Error(`"${input.color}" is not a section colour name`);
  }
  const siblings = s.childrenOf(input.parent);
  const sectionCount = [...s.nodes.values()].filter((n) => n.kind === 'section').length;
  const now = Date.now();
  return insertNode(doc, {
    kind: 'section',
    parent: input.parent,
    name: input.name,
    color: input.color ?? colorForIndex(sectionCount),
    order: orderAt(siblings, input.index ?? siblings.length),
    createdAt: now,
    modifiedAt: now,
  });
}

/**
 * Adds a page entry to a section and returns the page id. The page doc
 * (`pg:<id>`) is not created here; it starts empty when first opened.
 */
export function createPage(
  doc: Y.Doc,
  input: {
    section: string;
    title?: string;
    level?: PageLevel;
    index?: number;
    createdAt?: number;
    modifiedAt?: number;
  },
): string {
  const s = new Structure(doc);
  assertSection(s, input.section, 'a page');
  const siblings = s.childrenOf(input.section);
  const createdAt = input.createdAt ?? Date.now();
  return insertNode(doc, {
    kind: 'page',
    parent: input.section,
    name: input.title ?? '',
    level: input.level ?? 0,
    order: orderAt(siblings, input.index ?? siblings.length),
    createdAt,
    modifiedAt: input.modifiedAt ?? createdAt,
  });
}

/** Renames a group or section, or retitles a page. Updates modifiedAt. */
export function renameNode(doc: Y.Doc, id: string, name: string): void {
  const map = getNodeMap(doc, id);
  doc.transact(() => {
    map.set('name', name);
    map.set('modifiedAt', Date.now());
  });
}

export function setSectionColor(doc: Y.Doc, id: string, color: ColorName): void {
  const map = getNodeMap(doc, id);
  if (map.get('kind') !== 'section') throw new Error(`Node ${id} is not a section`);
  if (!isColorName(color)) throw new Error(`"${color}" is not a section colour name`);
  map.set('color', color);
}

/**
 * Moves a node to a new parent and position. A page's parent is a section; a
 * section's or group's parent is a group or null for the root. A page takes
 * its subpages with it, keeping their order and levels; `index` counts the
 * pages left in the target section once the moved pages are out. Moving a
 * group under itself or one of its own groups throws.
 */
export function moveNode(doc: Y.Doc, id: string, to: Placement): void {
  const map = getNodeMap(doc, id);
  const s = new Structure(doc);
  const node = s.nodes.get(id)!;
  if (node.kind === 'page') {
    assertSection(s, to.parent, `page ${id}`);
    const block = pageWithSubpages(s, node);
    const moving = new Set(block.map((p) => p.id));
    const siblings = s.childrenOf(to.parent).filter((p) => !moving.has(p.id));
    const orders = ordersAt(siblings, to.index ?? siblings.length, block.length);
    doc.transact(() => {
      block.forEach((p, i) => {
        const pageMap = getNodeMap(doc, p.id);
        pageMap.set('parent', to.parent);
        pageMap.set('order', orders[i]!);
      });
    });
    return;
  }
  assertContainerParent(s, to.parent, `${node.kind} ${id}`);
  if (node.kind === 'group' && to.parent !== null) {
    const inside = to.parent === id || s.descendantsOf(id).some((d) => d.id === to.parent);
    if (inside) throw new Error(`Cannot move section group ${id} inside itself`);
  }
  const siblings = s.childrenOf(to.parent, id);
  doc.transact(() => {
    map.set('parent', to.parent);
    map.set('order', orderAt(siblings, to.index ?? siblings.length));
  });
}

/** Makes a page a subpage (level 1 or 2) or promotes it (level 0). */
export function setPageLevel(doc: Y.Doc, id: string, level: PageLevel): void {
  const map = getNodeMap(doc, id);
  if (map.get('kind') !== 'page') throw new Error(`Node ${id} is not a page`);
  if (level !== 0 && level !== 1 && level !== 2) throw new Error(`Page level ${level} is not 0, 1 or 2`);
  map.set('level', level);
}

/**
 * Moves a node to Deleted notes. A page takes its subpages with it, each
 * marked deleted on its own. Deleting a deleted node keeps its first deletedAt.
 */
export function deleteNode(doc: Y.Doc, id: string): void {
  const map = getNodeMap(doc, id);
  const s = new Structure(doc);
  const node = s.nodes.get(id)!;
  const doomed = node.kind === 'page' ? pageWithSubpages(s, node) : [node];
  const now = Date.now();
  doc.transact(() => {
    for (const n of doomed) {
      const m = n.id === id ? map : getNodeMap(doc, n.id);
      if (m.get('deletedAt') == null) m.set('deletedAt', now);
    }
  });
}

/**
 * Brings a node back from Deleted notes, together with any deleted group or
 * section above it so it shows again. Throws when a page's section is gone.
 */
export function restoreNode(doc: Y.Doc, id: string): void {
  const s = new Structure(doc);
  const node = s.nodes.get(id);
  if (!node) throw new Error(`Node ${id} is not in this notebook`);
  if (node.kind === 'page' && s.parentOf(node) === undefined) {
    throw new Error(`Cannot restore page ${id}: its section ${node.parent} is gone`);
  }
  doc.transact(() => {
    for (let current: NodeEntry | undefined = node; current; ) {
      if (current.deletedAt !== null) getNodeMap(doc, current.id).set('deletedAt', null);
      const parent = s.parentOf(current);
      current = parent == null ? undefined : s.nodes.get(parent);
    }
  });
}

/**
 * Removes a node in Deleted notes, and everything under it, for good. Returns
 * the ids of the removed pages so their page docs can be dropped. A node that
 * is already gone returns []. Throws for a node that is not deleted.
 */
export function purgeNode(doc: Y.Doc, id: string): string[] {
  const s = new Structure(doc);
  const node = s.nodes.get(id);
  if (!node) return [];
  if (s.isLive(node)) throw new Error(`Cannot purge node ${id}: it is not in Deleted notes`);
  const removed = [node, ...s.descendantsOf(id)];
  doc.transact(() => {
    for (const n of removed) nodesMap(doc).delete(n.id);
  });
  return removed.filter((n) => n.kind === 'page').map((n) => n.id);
}

/** Sets a node's modifiedAt to now. A node that is gone is left alone. */
export function touchNode(doc: Y.Doc, id: string): void {
  nodesMap(doc).get(id)?.set('modifiedAt', Date.now());
}
