import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  addTextContainer,
  createGroup,
  createNotebook,
  createPage,
  createSection,
  deleteNode,
  getNode,
  listDeletedNodes,
  listNotebooks,
  moveNode,
  readPage,
  readTree,
  restoreNode,
  textContainerBody,
  bodyToText,
  type TreeChild,
} from '../src/index.js';
import { forkDoc, stateBytes, syncDocs } from './helpers.js';

/** Inserts text at the start of the first paragraph of a text container, as an editor would. */
function typeAtStart(doc: Y.Doc, containerId: string, text: string): void {
  const paragraph = textContainerBody(doc, containerId).get(0) as Y.XmlElement;
  (paragraph.get(0) as Y.XmlText).insert(0, text);
}

/** The plain text of a text container as the page reads it now. */
function containerText(doc: Y.Doc, containerId: string): string {
  const container = readPage(doc).containers.find((c) => c.id === containerId);
  if (container?.kind !== 'text') throw new Error(`No text container ${containerId}`);
  return bodyToText(container.body);
}

function expectConverged(a: Y.Doc, b: Y.Doc): void {
  expect(stateBytes(a)).toEqual(stateBytes(b));
}

const allIds = (children: TreeChild[]): string[] =>
  children.flatMap((c) => [c.id, ...(c.kind === 'group' ? allIds(c.children) : c.pages.map((p) => p.id))]);

describe('convergence', () => {
  it('keeps concurrent text edits in the same container', () => {
    const a = new Y.Doc();
    const t = addTextContainer(a, {
      x: 0,
      y: 0,
      width: 100,
      body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'base' }] }] },
    });
    const b = forkDoc(a);
    typeAtStart(a, t, 'alpha ');
    typeAtStart(b, t, 'beta ');
    syncDocs(a, b);
    expectConverged(a, b);
    const text = containerText(a, t);
    expect(text).toContain('alpha ');
    expect(text).toContain('beta ');
    expect(text).toContain('base');
    expect(readPage(a)).toEqual(readPage(b));
  });

  it('two replicas moving one node to different places leaves one node', () => {
    const a = new Y.Doc();
    const s1 = createSection(a, { name: 'One', parent: null });
    const s2 = createSection(a, { name: 'Two', parent: null });
    const s3 = createSection(a, { name: 'Three', parent: null });
    const page = createPage(a, { section: s1, title: 'Wanderer' });
    const b = forkDoc(a);
    moveNode(a, page, { parent: s2 });
    moveNode(b, page, { parent: s3 });
    syncDocs(a, b);
    expectConverged(a, b);
    for (const doc of [a, b]) {
      const ids = allIds(readTree(doc).children);
      expect(ids.filter((id) => id === page)).toHaveLength(1);
    }
    expect([s2, s3]).toContain(getNode(a, page)!.parent);
    expect(readTree(a)).toEqual(readTree(b));
  });

  it('keeps edits to a page deleted on another replica, and the page restores', () => {
    const nbA = new Y.Doc();
    const section = createSection(nbA, { name: 'S', parent: null });
    const page = createPage(nbA, { section, title: 'Contested' });
    const pgA = new Y.Doc();
    const t = addTextContainer(pgA, {
      x: 0,
      y: 0,
      width: 100,
      body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'start' }] }] },
    });
    const nbB = forkDoc(nbA);
    const pgB = forkDoc(pgA);

    deleteNode(nbA, page);
    typeAtStart(pgB, t, 'kept ');
    addTextContainer(pgB, { x: 0, y: 100, width: 100 });

    syncDocs(nbA, nbB);
    syncDocs(pgA, pgB);
    expectConverged(nbA, nbB);
    expectConverged(pgA, pgB);
    expect(listDeletedNodes(nbB).map((n) => n.id)).toEqual([page]);
    expect(readPage(pgA).containers).toHaveLength(2);
    restoreNode(nbB, page);
    expect(readTree(nbB).children[0]).toMatchObject({ pages: [{ id: page }] });
    expect(containerText(pgA, t)).toBe('kept start');
  });

  it('concurrent section creations both appear in the same order on both replicas', () => {
    const a = new Y.Doc();
    createSection(a, { name: 'Existing', parent: null });
    const b = forkDoc(a);
    const fromA = createSection(a, { name: 'From A', parent: null });
    const fromB = createSection(b, { name: 'From B', parent: null });
    syncDocs(a, b);
    expectConverged(a, b);
    const orderA = readTree(a).children.map((c) => c.id);
    expect(orderA).toEqual(readTree(b).children.map((c) => c.id));
    expect(orderA).toHaveLength(3);
    expect(orderA).toEqual(expect.arrayContaining([fromA, fromB]));
    expect(orderA[0]).not.toBe(fromA);
  });

  it('concurrent notebook creations converge in the library', () => {
    const a = new Y.Doc();
    const b = forkDoc(a);
    createNotebook(a, { name: 'A' });
    createNotebook(b, { name: 'B' });
    syncDocs(a, b);
    expectConverged(a, b);
    expect(listNotebooks(a)).toEqual(listNotebooks(b));
    expect(listNotebooks(a)).toHaveLength(2);
  });

  it('a group cycle made concurrently resolves the same way on both replicas', () => {
    const a = new Y.Doc();
    const g1 = createGroup(a, { name: 'G1', parent: null });
    const g2 = createGroup(a, { name: 'G2', parent: null });
    const inner = createSection(a, { name: 'Inside G1', parent: g1 });
    const b = forkDoc(a);
    moveNode(a, g1, { parent: g2 });
    moveNode(b, g2, { parent: g1 });
    syncDocs(a, b);
    expectConverged(a, b);
    const treeA = readTree(a);
    expect(treeA).toEqual(readTree(b));
    expect(treeA.children.map((c) => c.id).sort()).toEqual([g1, g2].sort());
    const ids = allIds(treeA.children);
    expect(ids.sort()).toEqual([g1, g2, inner].sort());
    const groupOne = treeA.children.find((c) => c.id === g1) as Extract<TreeChild, { kind: 'group' }>;
    expect(groupOne.children.map((c) => c.id)).toEqual([inner]);
  });

  it('a page moved with its subpages while another replica adds a subpage under it loses no page', () => {
    const a = new Y.Doc();
    const from = createSection(a, { name: 'From', parent: null });
    const to = createSection(a, { name: 'To', parent: null });
    createPage(a, { section: from, title: 'Before' });
    const parent = createPage(a, { section: from, title: 'Parent' });
    const child = createPage(a, { section: from, title: 'Child', level: 1 });
    createPage(a, { section: from, title: 'After' });
    const b = forkDoc(a);
    moveNode(a, parent, { parent: to });
    const added = createPage(b, { section: from, title: 'Added', level: 1, index: 3 });
    syncDocs(a, b);
    expectConverged(a, b);
    const treeA = readTree(a);
    expect(treeA).toEqual(readTree(b));
    expect(allIds(treeA.children)).toEqual(expect.arrayContaining([parent, child, added]));
    const pages = (i: number) => (treeA.children[i] as Extract<TreeChild, { kind: 'section' }>).pages;
    expect(pages(1).map((p) => p.id)).toEqual([parent, child]);
    // The added subpage stays where it was made and hangs under the page now above it.
    expect(pages(0).map((p) => `${p.title}@${p.level}`)).toEqual(['Before@0', 'Added@1', 'After@0']);
  });
});
