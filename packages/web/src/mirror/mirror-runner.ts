/**
 * The desktop app's mirror: keeps the folder the person chose in step with
 * this replica, as "Mirror" in docs/architecture.md describes. It plans with
 * `planMirror` over the sync client and hands the files to the shell in
 * batches; the shell owns the folder and every disk access, so nothing here
 * knows a path beyond the folder's name shown in Settings. Each change is
 * applied MIRROR_DELAY_MS after the last change to its doc, one plan at a
 * time; a plan that fails is logged and its changes are tried again with the
 * next change. Outside the desktop app no runner exists.
 */
import * as Y from 'yjs';
import type { SyncClient } from '@looseleaf/sync';
import { LIBRARY_DOC_ID, parseMirrorManifest, planMirror, type DocSource } from '@looseleaf/model';
import { Store } from '../app/store.js';
import { shell, type ShellBridge } from '../shell-bridge.js';
import { MIRROR_BATCH_LIMITS, mirrorBatches, type MirrorBatchLimits } from './mirror-batches.js';

/** A doc's change reaches the mirror this long after the doc's last change. The server's mirror uses the same delay. */
export const MIRROR_DELAY_MS = 5000;

const PAGE_PREFIX = 'pg:';
const NOTEBOOK_PREFIX = 'nb:';

export type MirrorBridge = Pick<
  ShellBridge,
  'chooseMirrorFolder' | 'mirrorFolder' | 'stopMirroring' | 'readMirrorManifest' | 'applyMirrorBatch'
>;
export type MirrorClient = Pick<SyncClient, 'openDoc' | 'releaseDoc' | 'getBlob' | 'onDocStored' | 'onBlobStored'>;

export interface MirrorState {
  /** The mirror folder, or null when mirroring is off. */
  folder: string | null;
  /** `not-empty`: the last folder chosen holds other files and was refused; the folder above is unchanged. */
  status: 'up-to-date' | 'writing' | 'failed' | 'not-empty';
  /** Why the last plan failed, while status is `failed`. */
  error: string | null;
}

export interface MirrorRunnerOptions {
  bridge: MirrorBridge;
  client: MirrorClient;
  /** Defaults to MIRROR_DELAY_MS. */
  delayMs?: number;
  /** Defaults to MIRROR_BATCH_LIMITS. */
  limits?: MirrorBatchLimits;
}

interface Pending {
  pages: Set<string>;
  blobs: Set<string>;
  /** A library or notebook doc changed, so paths need planning again. */
  paths: boolean;
  everything: boolean;
}

const nothingPending = (): Pending => ({ pages: new Set(), blobs: new Set(), paths: false, everything: false });

/** Thrown inside a plan whose folder changed or was turned off while it ran. */
class Interrupted extends Error {}

export class MirrorRunner {
  readonly state = new Store<MirrorState>({ folder: null, status: 'up-to-date', error: null });
  private readonly bridge: MirrorBridge;
  private readonly client: MirrorClient;
  private readonly delayMs: number;
  private readonly limits: MirrorBatchLimits;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly unsubscribe: Array<() => void>;
  private pending = nothingPending();
  /** Changes from failed or interrupted plans, folded into the next change's plan. */
  private retry = nothingPending();
  private running: Promise<void> | null = null;
  /** Bumped when the folder changes or mirroring stops, so a plan in progress stops before its next batch. */
  private generation = 0;
  /** True while the folder is being changed; no plan starts. */
  private paused = false;
  private closed = false;

  constructor(options: MirrorRunnerOptions) {
    this.bridge = options.bridge;
    this.client = options.client;
    this.delayMs = options.delayMs ?? MIRROR_DELAY_MS;
    this.limits = options.limits ?? MIRROR_BATCH_LIMITS;
    this.unsubscribe = [
      this.client.onDocStored((docId) => this.docStored(docId)),
      this.client.onBlobStored((hash) => this.later(`blob:${hash}`, (pending) => pending.blobs.add(hash))),
    ];
  }

  /** Reads the remembered folder and, when there is one, checks every page. */
  async start(): Promise<void> {
    const folder = await this.bridge.mirrorFolder();
    if (this.closed || this.state.get().folder !== null) return;
    this.state.set({ folder, status: 'up-to-date', error: null });
    if (folder !== null) this.checkEverything();
  }

  /** Shows the shell's folder picker. A folder it accepts becomes the mirror folder and gets a full check. */
  async chooseFolder(): Promise<void> {
    await this.pause();
    let choice;
    try {
      choice = await this.bridge.chooseMirrorFolder();
    } catch (error) {
      this.unpause();
      throw error;
    }
    if (choice.status === 'chosen') {
      this.paused = false;
      this.retry = nothingPending();
      this.pending = nothingPending();
      this.state.set({ folder: choice.folder, status: 'up-to-date', error: null });
      this.checkEverything();
      return;
    }
    if (choice.status === 'not-empty') this.state.update((state) => ({ ...state, status: 'not-empty', error: null }));
    this.unpause();
  }

  /** Turns mirroring off. Files already written stay. */
  async stop(): Promise<void> {
    await this.pause();
    try {
      await this.bridge.stopMirroring();
    } catch (error) {
      this.unpause();
      throw error;
    }
    this.paused = false;
    this.clearTimers();
    this.pending = nothingPending();
    this.retry = nothingPending();
    this.state.set({ folder: null, status: 'up-to-date', error: null });
  }

  /** Resolves once no change is waiting and no plan is running. */
  async whenIdle(): Promise<void> {
    while (this.running !== null || this.timers.size > 0) {
      await (this.running ?? new Promise((resolve) => setTimeout(resolve, 10)));
    }
  }

  /** Stops listening, drops changes still waiting for their delay and waits for a plan in progress. */
  async close(): Promise<void> {
    this.closed = true;
    for (const unsubscribe of this.unsubscribe) unsubscribe();
    this.clearTimers();
    await this.running;
  }

  private docStored(docId: string): void {
    this.later(docId, (pending) => {
      if (docId.startsWith(PAGE_PREFIX)) pending.pages.add(docId.slice(PAGE_PREFIX.length));
      else if (docId === LIBRARY_DOC_ID || docId.startsWith(NOTEBOOK_PREFIX)) pending.paths = true;
    });
  }

  private checkEverything(): void {
    this.pending.everything = true;
    this.kick();
  }

  private later(key: string, mark: (pending: Pending) => void): void {
    if (this.closed || this.state.get().folder === null) return;
    clearTimeout(this.timers.get(key));
    const timer = setTimeout(() => {
      this.timers.delete(key);
      mark(this.pending);
      this.resume();
    }, this.delayMs);
    this.timers.set(key, timer);
  }

  /** Interrupts a plan in progress and waits for it; its changes go to `retry`. */
  private async pause(): Promise<void> {
    this.paused = true;
    this.generation += 1;
    await this.running;
  }

  /** Lets plans start again and picks up the plan that `pause` interrupted. */
  private unpause(): void {
    this.paused = false;
    this.resume();
  }

  /** Folds the changes of failed or interrupted plans into the pending ones and starts a plan. */
  private resume(): void {
    merge(this.pending, this.retry);
    this.retry = nothingPending();
    this.kick();
  }

  private kick(): void {
    const folder = this.state.get().folder;
    if (this.running !== null || this.paused || this.closed || folder === null || isEmpty(this.pending)) return;
    const taken = this.pending;
    this.pending = nothingPending();
    const generation = this.generation;
    this.state.set({ folder, status: 'writing', error: null });
    this.running = this.run(taken, generation)
      .then(
        () => {
          if (generation === this.generation) this.state.set({ folder, status: 'up-to-date', error: null });
        },
        (error: unknown) => {
          merge(this.retry, taken);
          if (error instanceof Interrupted || generation !== this.generation) return;
          console.error(`Could not update the mirror in ${folder}; trying again at the next change`, error);
          this.state.set({ folder, status: 'failed', error: shellErrorMessage(error) });
        },
      )
      .finally(() => {
        this.running = null;
        this.kick();
      });
  }

  private async run(taken: Pending, generation: number): Promise<void> {
    const stillCurrent = () => {
      if (generation !== this.generation) throw new Interrupted();
    };
    const bytes = await this.bridge.readMirrorManifest();
    const previous = bytes === null ? null : parseMirrorManifest(bytes);
    const changedPages = new Set(taken.pages);
    for (const page of previous?.pages ?? []) {
      if (page.missingBlobs.some((hash) => taken.blobs.has(hash))) changedPages.add(page.id);
    }
    const plan = await planMirror({ source: copyingDocSource(this.client), previous, changedPages, checkEverything: taken.everything });
    for (const failure of plan.failures) {
      console.error(`Could not read page ${failure.pageId} for the mirror; its file stays as it was until the next change`, failure.error);
      this.retry.pages.add(failure.pageId);
    }
    const readBlob = async (hash: string) => {
      const blob = await this.client.getBlob(hash);
      if (blob === null) throw new Error(`Blob ${hash} for the mirror is not in the replica`);
      return blob;
    };
    for await (const batch of mirrorBatches(plan, previous, readBlob, this.limits)) {
      stillCurrent();
      const result = await this.bridge.applyMirrorBatch(batch);
      for (const { path, reason } of result.refused) console.warn(`The mirror skipped ${path}: ${reason}`);
    }
  }

  private clearTimers(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}

/** This session's mirror, started, or null outside the desktop app. */
export function startMirror(client: MirrorClient, bridge: MirrorBridge | null = shell()): MirrorRunner | null {
  if (bridge === null) return null;
  const runner = new MirrorRunner({ bridge, client });
  runner.start().catch((error: unknown) => console.error('Could not read the mirror folder setting', error));
  return runner;
}

/**
 * Reads each doc as a throwaway copy and releases the live one at once, so a
 * check of every page never holds every page doc open together.
 */
function copyingDocSource(client: MirrorClient): DocSource {
  return {
    async getDoc(docId) {
      const live = await client.openDoc(docId);
      try {
        const copy = new Y.Doc();
        Y.applyUpdate(copy, Y.encodeStateAsUpdate(live));
        return copy;
      } finally {
        client.releaseDoc(docId);
      }
    },
    getBlob: (hash) => client.getBlob(hash),
  };
}

/** The shell's message without the prefix Electron adds to an error that crosses IPC. */
function shellErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']*': (?:[A-Za-z]*Error: )?/, '');
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
