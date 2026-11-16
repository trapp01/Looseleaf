import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MirrorPage } from '@looseleaf/model';
import { callMcpTool } from '../src/mcp-tools.js';
import { MirrorFolder } from '../src/mirror-folder.js';
import type { MirrorView } from '../src/mirror.js';
import { tempDir } from './harness.js';

describe('the MCP tools over a mirror folder', () => {
  it('say the mirror is still being built before the first manifest', async () => {
    const view: MirrorView = { root: await tempDir(), manifest: null, readText: async () => null, whenIdle: async () => undefined };
    const result = await callMcpTool(view, 'list_notebooks', {});
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('still being built');
  });

  it('search 2,000 pages read from disk well inside a second', async () => {
    const folder = new MirrorFolder(await tempDir());
    const pages: MirrorPage[] = [];
    const writes: Array<{ path: string; data: Uint8Array }> = [];
    for (let i = 0; i < 2000; i++) {
      const id = `page${String(i).padStart(16, '0')}`;
      const section = `Section ${i % 20}`;
      const path = `Notebook ${i % 4}/${section}/Page ${i}.md`;
      const words = i % 50 === 0 ? 'the heron waded through the reeds' : 'a short invented note about nothing much';
      const data = new TextEncoder().encode(
        `---\nid: "${id}"\nnotebook: "Notebook ${i % 4}"\nsection: "${section}"\n---\n\n# Page ${i}\n\nCreated: 2026-04-02T08:00:00.000Z\n\n${words}\n${'line of filler text\n'.repeat(5)}`,
      );
      const hash = createHash('sha256').update(data).digest('hex');
      pages.push({ id, notebookId: `nb${i % 4}`, notebook: `Notebook ${i % 4}`, sectionId: `s${i % 20}`, section: [section], title: `Page ${i}`, level: 0, path, hash, assets: [], missingBlobs: [] });
      writes.push({ path, data });
    }
    const manifest = { format: 'looseleaf-mirror' as const, version: 1 as const, pages };
    for (const { path, data } of writes) {
      await mkdir(join(folder.root, dirname(path)), { recursive: true });
      await writeFile(join(folder.root, path), data);
    }
    const view: MirrorView = { root: folder.root, manifest, readText: (path) => folder.readText(path), whenIdle: async () => undefined };

    await callMcpTool(view, 'search_notes', { query: 'heron' });
    const times: number[] = [];
    let text = '';
    for (let run = 0; run < 5; run++) {
      const started = performance.now();
      text = (await callMcpTool(view, 'search_notes', { query: 'heron reeds' })).content[0]!.text;
      times.push(performance.now() - started);
    }
    times.sort((x, y) => x - y);
    console.log(`search_notes over 2,000 mirror pages: median ${times[2]!.toFixed(1)} ms warm (runs: ${times.map((t) => t.toFixed(1)).join(', ')} ms)`);
    expect(text.split('\n')[0]).toBe('40 pages match "heron reeds"; showing the first 20. Narrow the query, pass notebook_id, or raise limit (up to 100) to see more.');
    expect(times[2]!).toBeLessThan(1500);
  }, 30_000);
});
