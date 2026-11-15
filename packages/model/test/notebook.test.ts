import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  createGroup,
  createPage,
  createSection,
  deleteNode,
  getNode,
  listDeletedNodes,
  moveNode,
  purgeNode,
  readTree,
  renameNode,
  restoreNode,
  setPageLevel,
  setSectionColor,
  touchNode,
  type ColorName,
  type TreeChild,
} from '../src/index.js';

/** The tree as nested names, with pages as `title@level`. */
function outline(doc: Y.Doc): unknown {
  const walk = (children: TreeChild[]): unknown[] =>
    children.map((c) =>
      c.kind === 'group' ? { [c.name]: walk(c.children) } : { [c.name]: c.pages.map((p) => `${p.title}@${p.level}`) },
    );
  return walk(readTree(doc).children);
}

function sample() {
  const doc = new Y.Doc();
  const group = createGroup(doc, { name: 'Projects', parent: null });
  const inbox = createSection(doc, { name: 'Inbox', parent: null, index: 0 });
  const plans = createSection(doc, { name: 'Plans', parent: group });
  const p1 = createPage(doc, { section: inbox, title: 'One' });
  const p2 = createPage(doc, { section: inbox, title: 'Two' });
  const p3 = createPage(doc, { section: plans, title: 'Three' });
  return { doc, group, inbox, plans, p1, p2, p3 };
}

describe('notebook tree', () => {
  it('reads a sorted tree of groups, sections and pages', () => {
    const { doc, inbox } = sample();
    expect(outline(doc)).toEqual([{ Inbox: ['One@0', 'Two@0'] }, { Projects: [{ Plans: ['Three@0'] }] }]);
    const section = readTree(doc).children[0]!;
    expect(section).toMatchObject({ kind: 'section', id: inbox, name: 'Inbox' });
  });

  it('stores the node layout the architecture describes', () => {
    const { doc, inbox, p1, group } = sample();
    const raw = (id: string) => (doc.getMap('nodes').get(id) as Y.Map<unknown>).toJSON();
    expect(Object.keys(raw(p1)).sort()).toEqual(
      ['createdAt', 'deletedAt', 'kind', 'level', 'modifiedAt', 'name', 'order', 'parent'].sort(),
    );
    expect(raw(p1)).toMatchObject({ kind: 'page', parent: inbox, name: 'One', level: 0, deletedAt: null });
    expect(raw(inbox)).toMatchObject({ kind: 'section', parent: null });
    expect(typeof raw(inbox).color).toBe('string');
    expect(raw(group).color).toBeUndefined();
  });

  it('creates pages at a position and level, returning the id without making a page doc', () => {
    const { doc, inbox } = sample();
    const id = createPage(doc, { section: inbox, title: 'Between', index: 1, level: 1 });
    expect(outline(doc)).toEqual([{ Inbox: ['One@0', 'Between@1', 'Two@0'] }, { Projects: [{ Plans: ['Three@0'] }] }]);
    expect(getNode(doc, id)).toMatchObject({ kind: 'page', name: 'Between', level: 1 });
  });

  it('refuses parents of the wrong kind', () => {
    const { doc, group, inbox, p1 } = sample();
    expect(() => createPage(doc, { section: group })).toThrow(/not a section/);
    expect(() => createSection(doc, { name: 'x', parent: inbox })).toThrow(/not a section group/);
    expect(() => moveNode(doc, p1, { parent: null })).toThrow(/not a section/);
    expect(() => moveNode(doc, inbox, { parent: p1 })).toThrow(/not a section group/);
  });

  it('renames, recolours and touches', async () => {
    const { doc, inbox, p1 } = sample();
    const before = getNode(doc, p1)!.modifiedAt;
    await new Promise((r) => setTimeout(r, 2));
    renameNode(doc, p1, 'First');
    renameNode(doc, inbox, 'Tray');
    setSectionColor(doc, inbox, 'olive');
    expect(getNode(doc, p1)!.modifiedAt).toBeGreaterThan(before);
    expect(readTree(doc).children[0]).toMatchObject({ name: 'Tray', color: 'olive' });
    expect(() => setSectionColor(doc, p1, 'olive')).toThrow(/not a section/);
    expect(() => setSectionColor(doc, inbox, 'nope' as ColorName)).toThrow(/nope/);
    const touched = getNode(doc, p1)!.modifiedAt;
    await new Promise((r) => setTimeout(r, 2));
    touchNode(doc, p1);
    expect(getNode(doc, p1)!.modifiedAt).toBeGreaterThan(touched);
    expect(() => touchNode(doc, 'gone')).not.toThrow();
  });

  it('moves pages between sections and sections between groups', () => {
    const { doc, group, inbox, plans, p1 } = sample();
    moveNode(doc, p1, { parent: plans, index: 0 });
    expect(outline(doc)).toEqual([{ Inbox: ['Two@0'] }, { Projects: [{ Plans: ['One@0', 'Three@0'] }] }]);
    moveNode(doc, inbox, { parent: group });
    expect(outline(doc)).toEqual([{ Projects: [{ Plans: ['One@0', 'Three@0'] }, { Inbox: ['Two@0'] }] }]);
    moveNode(doc, inbox, { parent: group, index: 0 });
    expect(outline(doc)).toEqual([{ Projects: [{ Inbox: ['Two@0'] }, { Plans: ['One@0', 'Three@0'] }] }]);
  });

  it('refuses to move a group inside itself', () => {
    const { doc, group } = sample();
    const inner = createGroup(doc, { name: 'Inner', parent: group });
    expect(() => moveNode(doc, group, { parent: group })).toThrow(/inside itself/);
    expect(() => moveNode(doc, group, { parent: inner })).toThrow(/inside itself/);
  });

  it('sets page levels and clamps them under the page above', () => {
    const { doc, inbox, p1, p2 } = sample();
    setPageLevel(doc, p2, 1);
    expect(outline(doc)).toMatchObject([{ Inbox: ['One@0', 'Two@1'] }, {}]);
    setPageLevel(doc, p1, 2);
    expect(outline(doc)).toMatchObject([{ Inbox: ['One@0', 'Two@1'] }, {}]);
    const p0 = createPage(doc, { section: inbox, title: 'Zero', index: 0 });
    expect(outline(doc)).toMatchObject([{ Inbox: ['Zero@0', 'One@1', 'Two@1'] }, {}]);
    setPageLevel(doc, p0, 0);
    expect(() => setPageLevel(doc, inbox, 1)).toThrow(/not a page/);
    expect(() => setPageLevel(doc, p1, 3 as 0)).toThrow(/0, 1 or 2/);
  });

  it('deletes into Deleted notes and restores', () => {
    const { doc, inbox, p1, group } = sample();
    deleteNode(doc, p1);
    deleteNode(doc, p1);
    expect(outline(doc)).toEqual([{ Inbox: ['Two@0'] }, { Projects: [{ Plans: ['Three@0'] }] }]);
    deleteNode(doc, group);
    expect(outline(doc)).toEqual([{ Inbox: ['Two@0'] }]);
    expect(listDeletedNodes(doc).map((n) => n.id).sort()).toEqual([group, p1].sort());
    restoreNode(doc, p1);
    restoreNode(doc, group);
    expect(outline(doc)).toEqual([{ Inbox: ['One@0', 'Two@0'] }, { Projects: [{ Plans: ['Three@0'] }] }]);
    deleteNode(doc, inbox);
    expect(readTree(doc).children.map((c) => c.name)).toEqual(['Projects']);
    restoreNode(doc, inbox);
    expect(listDeletedNodes(doc)).toEqual([]);
  });

  it('restoring a page also restores the section it sits in', () => {
    const { doc, inbox, p1 } = sample();
    deleteNode(doc, p1);
    deleteNode(doc, inbox);
    restoreNode(doc, p1);
    expect(outline(doc)).toMatchObject([{ Inbox: ['One@0', 'Two@0'] }, {}]);
  });

  it('purges a deleted node and everything under it', () => {
    const { doc, group, plans, p3 } = sample();
    expect(() => purgeNode(doc, group)).toThrow(/not in Deleted notes/);
    deleteNode(doc, group);
    expect(purgeNode(doc, group)).toEqual([p3]);
    expect(getNode(doc, group)).toBeNull();
    expect(getNode(doc, plans)).toBeNull();
    expect(getNode(doc, p3)).toBeNull();
    expect(purgeNode(doc, group)).toEqual([]);
  });

  it('puts a group or section whose parent is gone at the root', () => {
    const { doc, group, plans } = sample();
    doc.getMap('nodes').delete(group);
    expect(readTree(doc).children.map((c) => c.id)).toContain(plans);
  });

  describe('subpages', () => {
    /** Inbox: Parent, Child@1, Grandchild@2, Sibling@0, plus an empty Other section. */
    function family() {
      const doc = new Y.Doc();
      const inbox = createSection(doc, { name: 'Inbox', parent: null });
      const other = createSection(doc, { name: 'Other', parent: null });
      const first = createPage(doc, { section: inbox, title: 'First' });
      const parent = createPage(doc, { section: inbox, title: 'Parent' });
      const child = createPage(doc, { section: inbox, title: 'Child', level: 1 });
      const grandchild = createPage(doc, { section: inbox, title: 'Grandchild', level: 2 });
      const sibling = createPage(doc, { section: inbox, title: 'Sibling' });
      return { doc, inbox, other, first, parent, child, grandchild, sibling };
    }

    it('move with their page, keeping order and levels', () => {
      const { doc, other, parent } = family();
      moveNode(doc, parent, { parent: other });
      expect(outline(doc)).toEqual([
        { Inbox: ['First@0', 'Sibling@0'] },
        { Other: ['Parent@0', 'Child@1', 'Grandchild@2'] },
      ]);
    });

    it('move within the section as a block', () => {
      const { doc, inbox, parent } = family();
      moveNode(doc, parent, { parent: inbox, index: 2 });
      expect(outline(doc)).toMatchObject([{ Inbox: ['First@0', 'Sibling@0', 'Parent@0', 'Child@1', 'Grandchild@2'] }, {}]);
      moveNode(doc, parent, { parent: inbox, index: 0 });
      expect(outline(doc)).toMatchObject([{ Inbox: ['Parent@0', 'Child@1', 'Grandchild@2', 'First@0', 'Sibling@0'] }, {}]);
    });

    it('a subpage takes only its own deeper pages', () => {
      const { doc, other, child } = family();
      moveNode(doc, child, { parent: other });
      expect(outline(doc)).toEqual([
        { Inbox: ['First@0', 'Parent@0', 'Sibling@0'] },
        { Other: ['Child@0', 'Grandchild@1'] },
      ]);
    });

    it('are deleted with their page, each on its own, and stay deleted when the page is restored', () => {
      const { doc, parent, child, grandchild } = family();
      deleteNode(doc, parent);
      expect(outline(doc)).toMatchObject([{ Inbox: ['First@0', 'Sibling@0'] }, {}]);
      expect(listDeletedNodes(doc).map((n) => n.id).sort()).toEqual([parent, child, grandchild].sort());
      restoreNode(doc, parent);
      expect(outline(doc)).toMatchObject([{ Inbox: ['First@0', 'Parent@0', 'Sibling@0'] }, {}]);
      restoreNode(doc, child);
      restoreNode(doc, grandchild);
      expect(outline(doc)).toMatchObject([{ Inbox: ['First@0', 'Parent@0', 'Child@1', 'Grandchild@2', 'Sibling@0'] }, {}]);
    });
  });
});
