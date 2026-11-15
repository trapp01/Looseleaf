import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { LIBRARY_DOC_ID, listNotebooks, type ImportedNotebook } from '@looseleaf/model';
import { MemoryStore, SyncClient } from '@looseleaf/sync';
import {
  clientDocSink,
  groupWarnings,
  importNotebooks,
  plainError,
  plainWarning,
  type ImportProgress,
  type ImportSink,
  type ImportSource,
  type ParseNotebook,
} from '../src/importing/import-run.js';

describe('groupWarnings', () => {
  it('groups by what happened, ignoring numbers, most frequent first, with a few places', () => {
    const groups = groupWarnings([
      'Notes / Monday: 3 ink strokes were not imported',
      'Notes / Tuesday: 12 ink strokes were not imported',
      'Notes / Tuesday: a picture in a onefiles folder was left out',
      'Work / Plan: 1 ink strokes were not imported',
      'Work / Extra: 5 ink strokes were not imported',
    ]);
    expect(groups.map((g) => [g.message, g.count])).toEqual([
      ['3 ink strokes were not imported', 4],
      ['a picture in a onefiles folder was left out', 1],
    ]);
    expect(groups[0]!.places).toEqual(['Notes / Monday', 'Notes / Tuesday', 'Work / Plan']);
  });

  it('says in plain words why a section could not be read', () => {
    expect(plainWarning('This section could not be imported: Secret.one: The section is password-protected (encrypted object space)')).toMatch(/password-protected section was skipped/);
    expect(plainWarning('This section could not be imported: x.one: This section is in the packaging OneDrive downloads use, which this reader does not support yet (…)')).toMatch(/downloaded from OneDrive/);
    expect(plainWarning('This section could not be imported: x.one: Not a OneNote section (only 3 bytes)')).toMatch(/not a OneNote section/);
    expect(plainWarning('This section could not be imported: x.one: The file structure cannot be read (bad)')).toBe('A damaged section file was skipped.');
    expect(plainError({ name: 'EncryptedSectionError', message: 'x' })).toMatch(/password-protected/);
    expect(plainError({ name: 'Error', message: 'disk full' })).toBe('The import stopped: disk full');
  });
});

function memorySink(docs = new Map<string, Y.Doc>()): ImportSink {
  return {
    getDoc: async (id) => {
      let d = docs.get(id);
      if (!d) docs.set(id, (d = new Y.Doc()));
      return d;
    },
    putBlob: async () => 'a'.repeat(64),
    flush: async () => undefined,
  };
}

function source(name: string): ImportSource {
  return { notebookName: name, files: [{ path: 'S.one', size: 1, read: async () => new Uint8Array() }] };
}

function treeOf(name: string, pages: number): ImportedNotebook {
  return {
    name,
    children: [
      {
        kind: 'section',
        name: 'S',
        pages: Array.from({ length: pages }, (_, i) => ({
          title: `P${i}`,
          level: 0,
          containers: [{ kind: 'image' as const, x: 0, y: 0, width: 5, height: 5, data: new Uint8Array([i]), mime: 'image/png', name: 'a.png' }],
          strokes: [],
          warnings: [],
        })),
      },
    ],
  };
}

const parseByName =
  (trees: Record<string, ImportedNotebook | Error>): ParseNotebook =>
  async (s) => {
    const tree = trees[s.notebookName]!;
    if (tree instanceof Error) throw tree;
    return tree;
  };

/** A replica store whose doc writes wait until `open` is called. */
class SlowStore extends MemoryStore {
  open: () => void = () => undefined;
  private readonly gate = new Promise<void>((resolve) => (this.open = resolve));
  pending = 0;
  override async appendUpdate(docId: string, update: Uint8Array): Promise<void> {
    this.pending++;
    await this.gate;
    this.pending--;
    return super.appendUpdate(docId, update);
  }
}

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('importNotebooks', () => {
  it('imports each source, reports progress and totals', async () => {
    const docs = new Map<string, Y.Doc>();
    const sink = memorySink(docs);
    const tree: ImportedNotebook = {
      name: 'Imported',
      children: [
        {
          kind: 'section',
          name: 'S',
          pages: [
            { title: 'P1', level: 0, containers: [{ kind: 'image', x: 0, y: 0, width: 5, height: 5, data: new Uint8Array([1]), mime: 'image/png', name: 'a.png' }], strokes: [], warnings: ['2 ink strokes were not imported'] },
            { title: 'P2', level: 0, containers: [], strokes: [], warnings: [] },
          ],
        },
      ],
    };
    const progress: ImportProgress[] = [];
    const report = await importNotebooks(
      [{ notebookName: 'Imported', files: [{ path: 'S.one', size: 1, read: async () => new Uint8Array() }] }],
      sink,
      async (source, onFile) => {
        source.files.forEach((f) => onFile(f.path));
        return tree;
      },
      (p) => progress.push(p),
    );
    expect(report).toMatchObject({ imported: ['Imported'], failed: [], sections: 1, pages: 2, pictures: 1 });
    expect(report.warnings).toEqual([{ message: '2 ink strokes were not imported', count: 1, places: ['S / P1'] }]);
    expect(progress[0]).toEqual({ kind: 'reading', notebook: 'Imported', path: 'S.one' });
    expect(progress.filter((p) => p.kind === 'writing')).toHaveLength(2);
    expect(progress.at(-1)).toEqual({ kind: 'saving' });
    expect(listNotebooks(docs.get(LIBRARY_DOC_ID)!).map((n) => n.name)).toEqual(['Imported']);
  });

  it('lists which notebooks came across when a later one fails, with each failure as is', async () => {
    const docs = new Map<string, Y.Doc>();
    const report = await importNotebooks(
      [source('First'), source('Locked'), source('Third')],
      memorySink(docs),
      parseByName({ First: treeOf('First', 1), Locked: Object.assign(new Error('x'), { name: 'EncryptedSectionError' }), Third: treeOf('Third', 2) }),
      () => undefined,
    );
    expect(report.imported).toEqual(['First', 'Third']);
    expect(report.failed).toEqual([{ notebook: 'Locked', message: plainError({ name: 'EncryptedSectionError', message: 'x' }) }]);
    expect(report.pages).toBe(3);
  });

  it('shows the model’s own message when writing a notebook fails partway', async () => {
    const sink = memorySink();
    const failing: ImportSink = {
      ...sink,
      getDoc: (id) => (id.startsWith('pg:') ? Promise.reject(new Error('disk trouble')) : sink.getDoc(id)),
    };
    const report = await importNotebooks([source('Big')], failing, parseByName({ Big: treeOf('Big', 1) }), () => undefined);
    expect(report.imported).toEqual([]);
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0]!.message).toMatch(/^Importing "Big" failed: disk trouble.*Deleted notes/);
  });

  it('reaches the report only after the replica store has every write', async () => {
    const store = new SlowStore();
    const client = await SyncClient.create({ store, tabChannel: null });
    const sink = clientDocSink(client);
    const progress: ImportProgress[] = [];
    let reported = false;
    const done = importNotebooks([source('Slow')], sink, parseByName({ Slow: treeOf('Slow', 30) }), (p) => progress.push(p)).then((report) => {
      reported = true;
      return report;
    });
    await until(() => progress.at(-1)?.kind === 'saving' && store.pending > 0);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(reported).toBe(false);
    store.open();
    const report = await done;
    expect(store.pending).toBe(0);
    expect(report.pages).toBe(30);
    const stored = await store.listDocs();
    expect(stored.filter((id) => id.startsWith('pg:'))).toHaveLength(30);
    expect(stored).toContain(LIBRARY_DOC_ID);
    sink.close();
    await client.close();
  });

  it('fails with the store’s message when the device refuses the writes', async () => {
    const store = new MemoryStore();
    store.appendUpdate = async () => {
      throw new Error('The disk is full');
    };
    const client = await SyncClient.create({ store, tabChannel: null });
    const sink = clientDocSink(client);
    const run = importNotebooks([source('Full')], sink, parseByName({ Full: treeOf('Full', 2) }), () => undefined);
    await expect(run).rejects.toThrow(/^The import couldn’t be saved on this device: .*The disk is full/);
    await expect(run.catch((error: Error) => plainError(error))).resolves.toMatch(/^The import couldn’t be saved on this device: /);
    sink.close();
    await client.close().catch(() => undefined);
  });
});
