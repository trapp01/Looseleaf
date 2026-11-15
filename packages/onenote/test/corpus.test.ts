// Reads a folder of real section files when LOOSELEAF_ONE_SAMPLES points at one.
// Real notebooks never enter the repo, so without the variable this suite is skipped.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ImportedBlock, ImportedSection } from '../../model/src/import-tree.js';
import { OneNoteReadError, readOneSection } from '../src/index.js';

const samples = process.env.LOOSELEAF_ONE_SAMPLES;

function listSectionFiles(dir: string): string[] {
  const out: string[] = [];
  const pending = [dir];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const name of readdirSync(current)) {
      const path = join(current, name);
      if (statSync(path).isDirectory()) pending.push(path);
      else if (name.toLowerCase().endsWith('.one')) out.push(path);
    }
  }
  return out.sort();
}

interface Totals {
  [key: string]: number;
}

function countSection(section: ImportedSection, totals: Totals, warnings: Map<string, number>): void {
  const add = (key: string, n = 1) => (totals[key] = (totals[key] ?? 0) + n);
  for (const page of section.pages) {
    add('pages');
    for (const warning of page.warnings) {
      const times = /\((\d+) times\)$/.exec(warning);
      const key = warning.replace(/ \(\d+ times\)$/, '').replace(/"[^"]*"/g, '"…"').replace(/\d+/g, 'N');
      warnings.set(key, (warnings.get(key) ?? 0) + (times ? Number(times[1]) : 1));
      const strokes = /^Ink drawing not imported \((\d+) strokes\)/.exec(warning);
      if (strokes) add('ink strokes (counted, not imported)', Number(strokes[1]));
    }
    add('strokes', page.strokes.length);
    for (const container of page.containers) {
      add('containers');
      if (container.kind === 'image') add('images');
      if (container.kind === 'file') add('files');
      if (container.kind !== 'text') continue;
      const pending: ImportedBlock[] = [...container.blocks];
      while (pending.length > 0) {
        const block = pending.pop()!;
        if (block.type === 'paragraph') add('paragraphs');
        else if (block.type === 'image') add('images');
        else if (block.type === 'table') {
          add('tables');
          for (const row of block.rows) for (const cell of row) pending.push(...cell.blocks);
        } else {
          for (const item of block.items) {
            add('list items');
            pending.push(...item.blocks);
          }
        }
      }
    }
  }
}

describe.skipIf(!samples)('sample corpus', () => {
  it('reads every section file, throwing only typed errors', () => {
    const files = listSectionFiles(samples!);
    const totals: Totals = { files: files.length, 'files read': 0 };
    const errors = new Map<string, number>();
    const warnings = new Map<string, number>();
    let slowest = { ms: 0, bytes: 0 };
    for (const path of files) {
      const bytes = new Uint8Array(readFileSync(path));
      const started = performance.now();
      try {
        const section = readOneSection(bytes, { name: relative(samples!, path) });
        totals['files read']!++;
        countSection(section, totals, warnings);
      } catch (e) {
        expect(e).toBeInstanceOf(OneNoteReadError);
        const name = (e as Error).name;
        errors.set(name, (errors.get(name) ?? 0) + 1);
      }
      const ms = performance.now() - started;
      if (ms > slowest.ms) slowest = { ms, bytes: bytes.length };
    }
    console.table(totals);
    console.table(Object.fromEntries(errors));
    console.table(Object.fromEntries([...warnings].sort((a, b) => b[1] - a[1])));
    console.log(`Slowest file: ${(slowest.bytes / 1e6).toFixed(1)} MB in ${slowest.ms.toFixed(0)} ms`);
  }, 230_000);
});
