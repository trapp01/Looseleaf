import { strFromU8 } from 'fflate';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  LIBRARY_DOC_ID,
  addImageContainer,
  addTextContainer,
  createGroup,
  createNotebook,
  createPage,
  createSection,
  deleteNode,
  deleteNotebook,
  moveNode,
  notebookDocId,
  pageDocId,
  parseMirrorManifest,
  planMirror,
  renameNode,
  renameNotebook,
  restoreNode,
  serializeMirrorManifest,
  type MirrorManifest,
  type MirrorPlan,
} from '../src/index.js';
import { MemoryReplica, PNG_BYTES, sha256 } from './helpers.js';

const CREATED = Date.UTC(2026, 2, 1, 9, 0);

/** A replica that counts page doc reads and can be told to fail one. */
class CountingReplica extends MemoryReplica {
  pageReads: string[] = [];
  failing = new Set<string>();

  override async getDoc(docId: string): Promise<Y.Doc> {
    if (docId.startsWith('pg:')) {
      this.pageReads.push(docId.slice(3));
      if (this.failing.has(docId)) throw new Error(`cannot read ${docId}`);
    }
    return super.getDoc(docId);
  }
}

/** A mirror folder held in memory, changed the way a host applies a plan. */
class Mirror {
  readonly files = new Map<string, Uint8Array>();
  manifest: MirrorManifest | null = null;

  constructor(readonly replica: CountingReplica) {}

  async plan(changedPages: string[] = [], checkEverything = false): Promise<MirrorPlan> {
    this.replica.pageReads = [];
    const plan = await planMirror({ source: this.replica, previous: this.manifest, changedPages, checkEverything });
    for (const path of plan.removals) this.files.delete(path);
    for (const file of plan.writes) this.files.set(file.path, file.data);
    for (const asset of plan.assets) this.files.set(asset.path, this.replica.blobs.get(asset.hash)!);
    this.manifest = plan.manifest;
    return plan;
  }

  text(path: string): string {
    const bytes = this.files.get(path);
    if (!bytes) throw new Error(`No file ${path}; have ${[...this.files.keys()].join(', ')}`);
    return strFromU8(bytes);
  }

  paths(): string[] {
    return [...this.files.keys()].sort();
  }
}

async function setup() {
  const replica = new CountingReplica();
  const library = await replica.getDoc(LIBRARY_DOC_ID);
  const notebookId = createNotebook(library, { name: 'Work' });
  const nb = await replica.getDoc(notebookDocId(notebookId));
  const group = createGroup(nb, { name: 'Clients', parent: null });
  const acme = createSection(nb, { name: 'Acme', parent: group });
  const notes = createSection(nb, { name: 'Notes', parent: null });
  const kickoff = createPage(nb, { section: acme, title: 'Kickoff', createdAt: CREATED });
  const review = createPage(nb, { section: acme, title: 'Review', createdAt: CREATED });
  const ideas = createPage(nb, { section: notes, title: 'Ideas', createdAt: CREATED });
  const write = async (pageId: string, text: string) =>
    addTextContainer(await replica.getDoc(pageDocId(pageId)), {
      x: 0,
      y: 0,
      width: 300,
      body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] },
    });
  await write(kickoff, 'First meeting');
  const mirror = new Mirror(replica);
  await mirror.plan();
  return { replica, library, notebookId, nb, group, acme, notes, kickoff, review, ideas, mirror, write };
}

describe('planning a mirror', () => {
  it('writes every page with front matter, in notebook order, when there is no manifest', async () => {
    const { mirror, kickoff, review, ideas, notebookId, acme } = await setup();
    expect(mirror.paths()).toEqual(['Work/Clients/Acme/Kickoff.md', 'Work/Clients/Acme/Review.md', 'Work/Notes/Ideas.md']);
    expect(mirror.text('Work/Clients/Acme/Kickoff.md')).toBe(
      `---\nid: "${kickoff}"\nnotebook: "Work"\nsection: "Clients / Acme"\n---\n\n# Kickoff\n\nCreated: ${new Date(CREATED).toISOString()}\n\nFirst meeting\n`,
    );
    expect(mirror.manifest!.pages.map((p) => p.id)).toEqual([kickoff, review, ideas]);
    expect(mirror.manifest!.pages[0]).toEqual({
      id: kickoff,
      notebookId,
      notebook: 'Work',
      sectionId: acme,
      section: ['Clients', 'Acme'],
      title: 'Kickoff',
      level: 0,
      path: 'Work/Clients/Acme/Kickoff.md',
      hash: sha256(mirror.files.get('Work/Clients/Acme/Kickoff.md')!),
      assets: [],
      missingBlobs: [],
    });
  });

  it('adds a new page without reading any other page', async () => {
    const { mirror, nb, notes } = await setup();
    const added = createPage(nb, { section: notes, title: 'Later' });
    const plan = await mirror.plan();
    expect(mirror.replica.pageReads).toEqual([added]);
    expect(plan.writes.map((f) => f.path)).toEqual(['Work/Notes/Later.md']);
    expect(plan.removals).toEqual([]);
  });

  it('re-renders only the page named as changed', async () => {
    const { mirror, kickoff, write } = await setup();
    await write(kickoff, 'Follow-up');
    const plan = await mirror.plan([kickoff]);
    expect(mirror.replica.pageReads).toEqual([kickoff]);
    expect(plan.writes.map((f) => f.path)).toEqual(['Work/Clients/Acme/Kickoff.md']);
    expect(mirror.text('Work/Clients/Acme/Kickoff.md')).toContain('Follow-up');
  });

  it('writes nothing for a page named as changed whose file comes out the same', async () => {
    const { mirror, review } = await setup();
    const plan = await mirror.plan([review]);
    expect(mirror.replica.pageReads).toEqual([review]);
    expect(plan.writes).toEqual([]);
  });

  it('moves the file when a page is renamed', async () => {
    const { mirror, nb, review } = await setup();
    renameNode(nb, review, 'Retro');
    const plan = await mirror.plan();
    expect(plan.removals).toEqual(['Work/Clients/Acme/Review.md']);
    expect(plan.writes.map((f) => f.path)).toEqual(['Work/Clients/Acme/Retro.md']);
    expect(mirror.text('Work/Clients/Acme/Retro.md')).toContain('# Retro');
  });

  it('moves the file and its front matter when a page moves to another section', async () => {
    const { mirror, nb, notes, kickoff } = await setup();
    moveNode(nb, kickoff, { parent: notes });
    const plan = await mirror.plan();
    expect(plan.removals).toEqual(['Work/Clients/Acme/Kickoff.md']);
    expect(plan.writes.map((f) => f.path)).toEqual(['Work/Notes/Kickoff.md']);
    expect(mirror.text('Work/Notes/Kickoff.md')).toContain('section: "Notes"');
  });

  it('removes a deleted page and writes it again when restored', async () => {
    const { mirror, nb, review } = await setup();
    deleteNode(nb, review);
    expect((await mirror.plan()).removals).toEqual(['Work/Clients/Acme/Review.md']);
    expect(mirror.manifest!.pages.map((p) => p.id)).not.toContain(review);
    restoreNode(nb, review);
    const plan = await mirror.plan();
    expect(plan.writes.map((f) => f.path)).toEqual(['Work/Clients/Acme/Review.md']);
    expect(plan.removals).toEqual([]);
  });

  it('removes every page of a deleted section', async () => {
    const { mirror, nb, acme } = await setup();
    deleteNode(nb, acme);
    const plan = await mirror.plan();
    expect(plan.removals.sort()).toEqual(['Work/Clients/Acme/Kickoff.md', 'Work/Clients/Acme/Review.md']);
    expect(mirror.paths()).toEqual(['Work/Notes/Ideas.md']);
  });

  it('removes every page of a deleted notebook', async () => {
    const { mirror, library, notebookId } = await setup();
    deleteNotebook(library, notebookId);
    const plan = await mirror.plan();
    expect(plan.removals).toHaveLength(3);
    expect(mirror.paths()).toEqual([]);
    expect(mirror.manifest!.pages).toEqual([]);
  });

  it('moves every page under a renamed section and updates the front matter', async () => {
    const { mirror, nb, acme } = await setup();
    renameNode(nb, acme, 'Acme Ltd');
    const plan = await mirror.plan();
    expect(plan.removals.sort()).toEqual(['Work/Clients/Acme/Kickoff.md', 'Work/Clients/Acme/Review.md']);
    expect(plan.writes.map((f) => f.path)).toEqual(['Work/Clients/Acme Ltd/Kickoff.md', 'Work/Clients/Acme Ltd/Review.md']);
    expect(mirror.text('Work/Clients/Acme Ltd/Kickoff.md')).toContain('section: "Clients / Acme Ltd"');
  });

  it('moves every page under a renamed notebook and updates the front matter', async () => {
    const { mirror, library, notebookId } = await setup();
    renameNotebook(library, notebookId, 'Job');
    const plan = await mirror.plan();
    expect(plan.removals).toHaveLength(3);
    expect(mirror.paths()).toEqual(['Job/Clients/Acme/Kickoff.md', 'Job/Clients/Acme/Review.md', 'Job/Notes/Ideas.md']);
    expect(mirror.text('Job/Notes/Ideas.md')).toContain('notebook: "Job"');
  });

  it('numbers a repeated title and renames the second when the first goes', async () => {
    const { mirror, nb, notes, ideas } = await setup();
    const second = createPage(nb, { section: notes, title: 'ideas' });
    await mirror.plan();
    expect(mirror.paths()).toContain('Work/Notes/ideas (2).md');
    deleteNode(nb, ideas);
    const plan = await mirror.plan();
    expect(plan.removals.sort()).toEqual(['Work/Notes/Ideas.md', 'Work/Notes/ideas (2).md']);
    expect(plan.writes.map((f) => f.path)).toEqual(['Work/Notes/ideas.md']);
    expect(mirror.manifest!.pages.find((p) => p.id === second)!.path).toBe('Work/Notes/ideas.md');
  });

  it('renames a file whose title changes only in case', async () => {
    const { mirror, nb, ideas } = await setup();
    renameNode(nb, ideas, 'IDEAS');
    const plan = await mirror.plan();
    expect(plan.removals).toEqual(['Work/Notes/Ideas.md']);
    expect(plan.writes.map((f) => f.path)).toEqual(['Work/Notes/IDEAS.md']);
  });

  it('numbers two titles that differ only in how an accent is composed', async () => {
    const { mirror, nb, notes } = await setup();
    createPage(nb, { section: notes, title: 'Caf\u00e9' });
    createPage(nb, { section: notes, title: 'Cafe\u0301' });
    await mirror.plan();
    expect(mirror.paths()).toContain('Work/Notes/Caf\u00e9.md');
    expect(mirror.paths()).toContain('Work/Notes/Cafe\u0301 (2).md');
  });

  it('asks the source whether a blob is there, when it can say, instead of reading it', async () => {
    const { mirror, replica, ideas } = await setup();
    const hash = await replica.putBlob(PNG_BYTES);
    addImageContainer(await replica.getDoc(pageDocId(ideas)), {
      x: 0, y: 100, width: 10, height: 10, blob: hash, mime: 'image/png', name: 'chart.png', size: PNG_BYTES.length,
    });
    const asked: string[] = [];
    const source = {
      getDoc: (docId: string) => replica.getDoc(docId),
      getBlob: async (): Promise<Uint8Array | null> => {
        throw new Error('the planner must not read blob bytes when hasBlob exists');
      },
      hasBlob: async (blob: string) => {
        asked.push(blob);
        return replica.blobs.has(blob);
      },
    };
    const plan = await planMirror({ source, previous: mirror.manifest, changedPages: [ideas], checkEverything: false });
    expect(asked).toEqual([hash]);
    expect(plan.assets).toEqual([{ path: `assets/${hash}.png`, hash }]);
  });

  it('writes a picture once for two pages and removes it with the last page that links to it', async () => {
    const { mirror, replica, nb, kickoff, ideas } = await setup();
    const hash = await replica.putBlob(PNG_BYTES);
    const picture = { x: 0, y: 100, width: 10, height: 10, blob: hash, mime: 'image/png', name: 'chart.png', size: PNG_BYTES.length };
    addImageContainer(await replica.getDoc(pageDocId(kickoff)), picture);
    addImageContainer(await replica.getDoc(pageDocId(ideas)), picture);
    const plan = await mirror.plan([kickoff, ideas]);
    expect(plan.assets).toEqual([{ path: `assets/${hash}.png`, hash }]);
    expect(mirror.files.get(`assets/${hash}.png`)).toEqual(PNG_BYTES);
    expect(mirror.text('Work/Clients/Acme/Kickoff.md')).toContain(`![chart.png](../../../assets/${hash}.png)`);
    expect(mirror.text('Work/Notes/Ideas.md')).toContain(`![chart.png](../../assets/${hash}.png)`);

    deleteNode(nb, kickoff);
    expect((await mirror.plan()).removals).toEqual(['Work/Clients/Acme/Kickoff.md']);
    deleteNode(nb, ideas);
    expect((await mirror.plan()).removals.sort()).toEqual(['Work/Notes/Ideas.md', `assets/${hash}.png`]);
  });

  it('records a missing blob and writes the asset once a later plan finds it', async () => {
    const { mirror, replica, ideas } = await setup();
    const hash = sha256(PNG_BYTES);
    addImageContainer(await replica.getDoc(pageDocId(ideas)), {
      x: 0, y: 100, width: 10, height: 10, blob: hash, mime: 'image/png', name: 'late.png', size: PNG_BYTES.length,
    });
    let plan = await mirror.plan([ideas]);
    expect(plan.assets).toEqual([]);
    expect(mirror.text('Work/Notes/Ideas.md')).toContain('[Missing picture: late.png]');
    expect(mirror.manifest!.pages.find((p) => p.id === ideas)!.missingBlobs).toEqual([hash]);

    await replica.putBlob(PNG_BYTES);
    plan = await mirror.plan([ideas]);
    expect(plan.assets).toEqual([{ path: `assets/${hash}.png`, hash }]);
    expect(mirror.text('Work/Notes/Ideas.md')).toContain(`![late.png](../../assets/${hash}.png)`);
    expect(mirror.manifest!.pages.find((p) => p.id === ideas)!.missingBlobs).toEqual([]);
  });

  it('treats a blob reference that is not a hash as missing and never as an asset path', async () => {
    const { mirror, replica, ideas } = await setup();
    addImageContainer(await replica.getDoc(pageDocId(ideas)), {
      x: 0, y: 100, width: 10, height: 10, blob: '../../escape', mime: 'image/png', name: 'x.png', size: 1,
    });
    replica.blobs.set('../../escape', PNG_BYTES);
    const plan = await mirror.plan([ideas]);
    expect(plan.assets).toEqual([]);
    expect(mirror.text('Work/Notes/Ideas.md')).toContain('[Missing picture: x.png]');
    expect(mirror.manifest!.pages.find((p) => p.id === ideas)!.missingBlobs).toEqual([]);
  });

  it('writes and removes nothing when asked to check everything and nothing changed', async () => {
    const { mirror } = await setup();
    const plan = await mirror.plan([], true);
    expect(mirror.replica.pageReads).toHaveLength(3);
    expect(plan.writes).toEqual([]);
    expect(plan.assets).toEqual([]);
    expect(plan.removals).toEqual([]);
  });

  it('removes nothing without a previous manifest', async () => {
    const { mirror, nb, review } = await setup();
    deleteNode(nb, review);
    mirror.manifest = null;
    const plan = await mirror.plan();
    expect(plan.removals).toEqual([]);
    expect(plan.writes).toHaveLength(2);
  });

  it('keeps the previous entry of a page whose doc cannot be read and reports it', async () => {
    const { mirror, replica, nb, kickoff, review } = await setup();
    const before = mirror.manifest!.pages.find((p) => p.id === kickoff);
    replica.failing.add(pageDocId(kickoff));
    renameNode(nb, review, 'Retro');
    const plan = await mirror.plan([kickoff, review]);
    expect(plan.failures.map((f) => f.pageId)).toEqual([kickoff]);
    expect(String(plan.failures[0]!.error)).toContain('cannot read');
    expect(plan.manifest.pages.find((p) => p.id === kickoff)).toEqual(before);
    expect(plan.removals).toEqual(['Work/Clients/Acme/Review.md']);
    expect(mirror.paths()).toContain('Work/Clients/Acme/Retro.md');
  });

  it('gives every awkward title valid front matter and a path inside the root', async () => {
    const replica = new CountingReplica();
    const library = await replica.getDoc(LIBRARY_DOC_ID);
    const titles = ['Say "hi"', 'Time: 9:30', '# heading', 'two\nlines', '../../etc/passwd', '...hidden', '🎉 party', '', '..', 'a\u2028b\u0085c'];
    const notebookId = createNotebook(library, { name: '../outside' });
    const nb = await replica.getDoc(notebookDocId(notebookId));
    const section = createSection(nb, { name: '.. / "..": #\u2028\u0085\n', parent: null });
    for (const title of titles) createPage(nb, { section, title });
    const mirror = new Mirror(replica);
    await mirror.plan();
    expect(mirror.manifest!.pages).toHaveLength(titles.length);
    for (const page of mirror.manifest!.pages) {
      const segments = page.path.split('/');
      expect(page.path.startsWith('/')).toBe(false);
      expect(segments.every((s) => s !== '' && s !== '.' && s !== '..' && !s.startsWith('.'))).toBe(true);
      expect(segments).toHaveLength(3);
      const lines = mirror.text(page.path).split('\n');
      expect(lines[0]).toBe('---');
      expect(lines[4]).toBe('---');
      const front = Object.fromEntries(
        lines.slice(1, 4).map((line) => {
          const match = /^(id|notebook|section): (".*")$/.exec(line);
          expect(match, line).not.toBeNull();
          expect(line).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/);
          return [match![1], JSON.parse(match![2]!) as string];
        }),
      );
      expect(front).toEqual({ id: page.id, notebook: '../outside', section: '.. / "..": #\u2028\u0085\n' });
    }
    expect(mirror.manifest!.pages.map((p) => p.path.split('/').pop())).toContain('Untitled page.md');
  });
});

describe('the mirror manifest', () => {
  it('survives a round trip', async () => {
    const { mirror } = await setup();
    expect(parseMirrorManifest(serializeMirrorManifest(mirror.manifest!))).toEqual(mirror.manifest);
  });

  it('parses anything else as null', async () => {
    const { mirror } = await setup();
    const good = JSON.parse(strFromU8(serializeMirrorManifest(mirror.manifest!))) as MirrorManifest;
    const variants: unknown[] = [
      null,
      42,
      [],
      { ...good, version: 2 },
      { ...good, format: 'other' },
      { ...good, pages: {} },
      { ...good, pages: [{ ...good.pages[0], path: '../escape.md' }] },
      { ...good, pages: [{ ...good.pages[0], path: '/etc/passwd' }] },
      { ...good, pages: [{ ...good.pages[0], path: 'a//b.md' }] },
      { ...good, pages: [{ ...good.pages[0], assets: ['../x'] }] },
      { ...good, pages: [{ ...good.pages[0], level: 3 }] },
      { ...good, pages: [{ ...good.pages[0], hash: 'short' }] },
    ];
    for (const variant of variants) expect(parseMirrorManifest(JSON.stringify(variant))).toBeNull();
    expect(parseMirrorManifest('{not json')).toBeNull();
    expect(parseMirrorManifest(new Uint8Array([0xff, 0xfe, 0x00]))).toBeNull();
    expect(parseMirrorManifest('')).toBeNull();
  });
});
