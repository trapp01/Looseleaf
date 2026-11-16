/**
 * Splits a mirror plan into batches small enough for one bridge call, in the
 * plan's order: removals, then assets, then pages. The shell applies each
 * batch as a plan of its own and writes its manifest last, so every batch
 * carries a manifest that is true of the folder once it is applied: the
 * previous manifest without the paths removed so far, with the plan's entry
 * for each page written so far, and the plan's own manifest on the last
 * batch. A failure between batches leaves a manifest that lists every file
 * the mirror has written, with the bytes it records; the next plan reads it
 * and does the rest. Knows nothing about the shell.
 */
import { MIRROR_ASSETS_FOLDER, serializeMirrorManifest, type MirrorManifest, type MirrorPlan } from '@looseleaf/model';
import type { MirrorBatch } from '../shell-bridge.js';

export interface MirrorBatchLimits {
  /** Removals and files in one batch. */
  files: number;
  /** Bytes of asset and page files in one batch. A single larger file goes in a batch alone. */
  bytes: number;
}

export const MIRROR_BATCH_LIMITS: MirrorBatchLimits = { files: 200, bytes: 8 * 1024 * 1024 };

/**
 * Yields the batches for a plan made against `previous`, reading each
 * asset's bytes with `readBlob` only when its batch is being filled. Always
 * yields at least one batch, the last one carrying `plan.manifest`.
 */
export async function* mirrorBatches(
  plan: Pick<MirrorPlan, 'writes' | 'assets' | 'removals' | 'manifest'>,
  previous: MirrorManifest | null,
  readBlob: (hash: string) => Promise<Uint8Array>,
  limits: MirrorBatchLimits = MIRROR_BATCH_LIMITS,
): AsyncGenerator<MirrorBatch> {
  const removed = new Set<string>();
  const written = new Set<string>();
  let batch = emptyBatch();
  let files = 0;
  let bytes = 0;
  // True when the next entry of `size` bytes belongs in a new batch.
  const full = (size: number) => files > 0 && (files + 1 > limits.files || bytes + size > limits.bytes);
  const take = (size: number) => {
    files += 1;
    bytes += size;
  };
  const finish = (): MirrorBatch => {
    const done = { ...batch, manifest: serializeMirrorManifest(partialManifest(previous, plan.manifest, removed, written)) };
    batch = emptyBatch();
    files = 0;
    bytes = 0;
    return done;
  };

  for (const path of plan.removals) {
    if (full(0)) yield finish();
    batch.removals.push(path);
    removed.add(path);
    take(0);
  }
  for (const asset of plan.assets) {
    const data = await readBlob(asset.hash);
    if (full(data.length)) yield finish();
    batch.assets.push({ path: asset.path, hash: asset.hash, bytes: data });
    written.add(asset.path);
    take(data.length);
  }
  for (const page of plan.writes) {
    if (full(page.data.length)) yield finish();
    batch.pages.push({ path: page.path, bytes: page.data });
    written.add(page.path);
    take(page.data.length);
  }
  yield { ...batch, manifest: serializeMirrorManifest(plan.manifest) };
}

function emptyBatch(): Omit<MirrorBatch, 'manifest'> {
  return { removals: [], assets: [], pages: [] };
}

/**
 * The previous manifest less every page whose file was removed or rewritten
 * and less removed assets, then the next manifest's entry for each page
 * written so far. Assets are written before pages, so a listed page's assets
 * are there.
 */
function partialManifest(previous: MirrorManifest | null, next: MirrorManifest, removed: Set<string>, written: Set<string>): MirrorManifest {
  const kept = (previous?.pages ?? [])
    .filter((page) => !removed.has(page.path) && !written.has(page.path))
    .map((page) => ({ ...page, assets: page.assets.filter((name) => !removed.has(`${MIRROR_ASSETS_FOLDER}/${name}`)) }));
  const rewritten = next.pages.filter((page) => written.has(page.path));
  return { format: 'looseleaf-mirror', version: 1, pages: [...kept, ...rewritten] };
}
