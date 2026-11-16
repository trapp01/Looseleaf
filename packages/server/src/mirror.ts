/**
 * The server's mirror: keeps <dataDir>/mirror/ in step with the store, as
 * "Mirror" in docs/architecture.md describes. The hub and the blob route
 * report which doc or blob was stored; each change is applied
 * MIRROR_DELAY_MS after the last change to that doc, one plan at a time.
 * Docs and blobs are read from the store, never from the hub's cache. A plan
 * that fails is logged and its changes are tried again with the next change;
 * nothing here throws into a sync write or a blob upload. This is the only
 * server file that reads what is inside a doc, and it does so through
 * `@looseleaf/model`.
 */
import { join } from 'node:path';
import * as Y from 'yjs';
import { LIBRARY_DOC_ID, planMirror, type DocSource, type MirrorManifest } from '@looseleaf/model';
import type { DiskStore } from './disk-store.js';
import { MirrorFolder } from './mirror-folder.js';

/** A doc's change reaches the mirror this long after the doc's last change. */
export const MIRROR_DELAY_MS = 5000;

const PAGE_PREFIX = 'pg:';
const NOTEBOOK_PREFIX = 'nb:';

export interface MirrorOptions {
  /** Defaults to MIRROR_DELAY_MS. */
  delayMs?: number;
}

/** What other parts of the server may read from a running mirror. */
export interface MirrorView {
  /** The mirror folder, absolute. */
  readonly root: string;
  /** The manifest of the last plan applied, or null before the start-up check finishes. */
  readonly manifest: MirrorManifest | null;
  /**
   * The text of a file at a manifest path, or null when it is not on disk.
   * Throws for a path that would leave the mirror folder.
   */
  readText(path: string): Promise<string | null>;
  /** Resolves once no change is waiting and no plan is running. */
  whenIdle(): Promise<void>;
}

interface Pending {
  pages: Set<string>;
  blobs: Set<string>;
  /** A library or notebook doc changed, so paths need planning again. */
  paths: boolean;
  everything: boolean;
}

const nothingPending = (): Pending => ({ pages: new Set(), blobs: new Set(), paths: false, everything: false });

export class Mirror implements MirrorView {
  private readonly folder: MirrorFolder;
  private readonly delayMs: number;
  private readonly source: DocSource;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private pending = nothingPending();
  /** Changes from failed plans, folded into the next change's plan. */
  private retry = nothingPending();
  private running: Promise<void> | null = null;
  private closed = false;
  private current: MirrorManifest | null = null;

  constructor(
    private readonly store: DiskStore,
    options: MirrorOptions = {},
  ) {
    this.folder = new MirrorFolder(join(store.dataDir, 'mirror'));
    this.delayMs = options.delayMs ?? MIRROR_DELAY_MS;
    this.source = {
      // A throwaway doc per read, so the mirror never holds more than the page it is rendering.
      getDoc: async (docId) => {
        const updates = await store.readUpdates(docId);
        const doc = new Y.Doc();
        if (updates.length > 0) Y.applyUpdate(doc, Y.mergeUpdates(updates));
        return doc;
      },
      getBlob: (hash) => store.getBlob(hash),
      hasBlob: (hash) => store.hasBlob(hash),
    };
  }

  get root(): string {
    return this.folder.root;
  }

  get manifest(): MirrorManifest | null {
    return this.current;
  }

  readText(path: string): Promise<string | null> {
    return this.folder.readText(path);
  }

  /** Starts the check of every page in the background. */
  start(): void {
    this.pending.everything = true;
    this.kick();
  }

  /** Called after a doc update is on disk. */
  docStored(docId: string): void {
    this.later(docId, (pending) => {
      if (docId.startsWith(PAGE_PREFIX)) pending.pages.add(docId.slice(PAGE_PREFIX.length));
      else if (docId === LIBRARY_DOC_ID || docId.startsWith(NOTEBOOK_PREFIX)) pending.paths = true;
    });
  }

  /** Called after a blob that was not stored before is on disk. */
  blobStored(hash: string): void {
    this.later(`blob:${hash}`, (pending) => pending.blobs.add(hash));
  }

  async whenIdle(): Promise<void> {
    while (this.running !== null || this.timers.size > 0) {
      await (this.running ?? new Promise((resolve) => setTimeout(resolve, 10)));
    }
  }

  /** Drops changes still waiting for their delay and waits for a plan in progress. */
  async close(): Promise<void> {
    this.closed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    await this.running;
  }

  private later(key: string, mark: (pending: Pending) => void): void {
    if (this.closed) return;
    clearTimeout(this.timers.get(key));
    const timer = setTimeout(() => {
      this.timers.delete(key);
      mark(this.pending);
      merge(this.pending, this.retry);
      this.retry = nothingPending();
      this.kick();
    }, this.delayMs);
    timer.unref();
    this.timers.set(key, timer);
  }

  private kick(): void {
    if (this.running !== null || this.closed || isEmpty(this.pending)) return;
    const taken = this.pending;
    this.pending = nothingPending();
    this.running = this.run(taken)
      .catch((error: unknown) => {
        console.error(`Could not update the mirror in ${this.root}; trying again at the next change`, error);
        merge(this.retry, taken);
      })
      .finally(() => {
        this.running = null;
        this.kick();
      });
  }

  private async run(taken: Pending): Promise<void> {
    const previous = await this.folder.readManifest();
    const changedPages = new Set(taken.pages);
    for (const page of previous?.pages ?? []) {
      if (page.missingBlobs.some((hash) => taken.blobs.has(hash))) changedPages.add(page.id);
    }
    const plan = await planMirror({ source: this.source, previous, changedPages, checkEverything: taken.everything });
    for (const failure of plan.failures) {
      console.error(`Could not read page ${failure.pageId} for the mirror; its file stays as it was until the next change`, failure.error);
      this.retry.pages.add(failure.pageId);
    }
    const result = await this.folder.apply(plan, async (hash) => (await this.store.openBlob(hash))?.stream ?? null);
    for (const { path, reason } of result.refused) console.warn(`The mirror skipped ${path} in ${this.root}: ${reason}`);
    this.current = plan.manifest;
  }
}

function merge(into: Pending, from: Pending): void {
  for (const page of from.pages) into.pages.add(page);
  for (const blob of from.blobs) into.blobs.add(blob);
  into.paths ||= from.paths;
  into.everything ||= from.everything;
}

function isEmpty(pending: Pending): boolean {
  return pending.pages.size === 0 && pending.blobs.size === 0 && !pending.paths && !pending.everything;
}
