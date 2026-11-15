/**
 * One connected socket's sync session, from hello to close. After the
 * server's welcome it runs the Yjs handshake for every doc either side holds,
 * at bounded concurrency, then forwards live updates both ways. A doc whose
 * handshake fails (unreadable locally, refused or unanswered by the server)
 * is recorded as failed and the session carries on with the rest. A new
 * socket gets a new session; nothing here survives a reconnect.
 */
import * as Y from 'yjs';
import {
  decodeFrame,
  decodeWelcome,
  encodeFrame,
  encodeHello,
  FrameType,
  type Frame,
} from './protocol.js';
import type { Replica } from './replica.js';
import type { SocketLike } from './transport.js';

/** At most this many docs are mid-handshake at once. */
export const HANDSHAKE_CONCURRENCY = 8;
/** A doc whose handshake gets no answer from the server within this time is recorded as failed. */
export const DOC_HANDSHAKE_TIMEOUT_MS = 30_000;

interface Handshake {
  diffApplied: boolean;
  diffSent: boolean;
  timer: ReturnType<typeof setTimeout>;
}

export type DocFailureKind = 'protocol' | 'store';

export interface SessionEvents {
  onWelcome(): void;
  /** Handshake progress changed, or a doc failed. */
  onProgress(): void;
  /** One doc could not be synced in this session; the others carry on. */
  onDocFailed(docId: string, kind: DocFailureKind, error: Error): void;
  /** The session cannot continue; the caller closes the socket and reconnects. */
  onFailure(kind: 'protocol' | 'store', error: Error): void;
}

export class Session {
  private welcomed = false;
  /** True once the docs from the welcome and the replica store have been planned. */
  private plannedAll = false;
  private ended = false;
  /** Docs waiting to start their handshake, in start order. */
  private queued: string[] = [];
  /** Every doc this session has taken on: queued, running, done or failed. */
  private readonly planned = new Set<string>();
  private readonly running = new Map<string, Handshake>();
  /** Docs this session holds loaded in the replica. */
  private readonly held = new Set<string>();
  /** Docs whose Diff has been sent; their new local changes go out as Updates. */
  private readonly live = new Set<string>();
  /** Docs that failed in this session, with the reason. */
  private readonly failed = new Map<string, string>();
  /** Planned docs whose handshake finished, whether it succeeded or failed. */
  private finished = 0;
  private priorityDoc: string | null;

  constructor(
    private readonly socket: SocketLike,
    private readonly replica: Replica,
    private readonly events: SessionEvents,
    priorityDoc: string | null,
    private readonly docTimeoutMs: number = DOC_HANDSHAKE_TIMEOUT_MS,
  ) {
    this.priorityDoc = priorityDoc;
  }

  get isWelcomed(): boolean {
    return this.welcomed;
  }

  /** Handshakes finished (failed ones included) and handshakes planned. */
  get progress(): { done: number; total: number } {
    return { done: this.finished, total: this.planned.size };
  }

  /** Every planned doc has finished its handshake; some may have failed (see `failedDocs`). */
  get isInStep(): boolean {
    return this.plannedAll && this.finished === this.planned.size;
  }

  get failedDocs(): string[] {
    return [...this.failed.keys()];
  }

  sendHello(token: string, replicaId: string): void {
    this.socket.send(encodeHello(token, replicaId));
  }

  receive(data: unknown): void {
    if (this.ended) return;
    try {
      if (typeof data === 'string') {
        this.receiveWelcome(data);
        return;
      }
      if (!this.welcomed) throw new Error('The server sent a binary frame before its welcome');
      this.receiveFrame(decodeFrame(toBytes(data)));
    } catch (error) {
      this.fail('protocol', error);
    }
  }

  /**
   * Sends a local change when the doc's handshake has sent its Diff.
   * Returns false when the change is not sent yet; the doc's handshake will
   * carry it, and a doc this session has not planned is planned now.
   */
  sendLocal(docId: string, update: Uint8Array): boolean {
    if (this.ended || !this.welcomed) return false;
    if (this.live.has(docId)) {
      this.send({ type: FrameType.Update, docId, payload: update });
      return true;
    }
    if (!this.planned.has(docId)) {
      this.plan([docId]);
      this.pump();
      this.events.onProgress();
    }
    return false;
  }

  /** Starts the doc's handshake before the remaining pages. */
  prioritize(docId: string | null): void {
    this.priorityDoc = docId;
    this.queued.sort((a, b) => this.rank(a) - this.rank(b));
  }

  /** Stops the session and releases the docs it holds. Safe to call more than once. */
  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const handshake of this.running.values()) clearTimeout(handshake.timer);
    for (const docId of this.held) this.replica.unhold(docId);
    this.held.clear();
    this.running.clear();
    this.queued = [];
  }

  private receiveWelcome(text: string): void {
    if (this.welcomed) throw new Error(`The server sent a second text frame: ${text.slice(0, 200)}`);
    const welcome = decodeWelcome(text);
    this.welcomed = true;
    this.events.onWelcome();
    void this.planAll(welcome.docs);
  }

  private async planAll(serverDocs: string[]): Promise<void> {
    let storedDocs: string[];
    try {
      storedDocs = await this.replica.listStoredDocs();
    } catch (error) {
      this.fail('store', error);
      return;
    }
    if (this.ended) return;
    this.plan([...serverDocs, ...storedDocs]);
    this.plannedAll = true;
    this.pump();
    this.events.onProgress();
  }

  private plan(docIds: string[]): void {
    for (const docId of docIds) {
      if (this.planned.has(docId)) continue;
      this.planned.add(docId);
      this.queued.push(docId);
    }
    this.queued.sort((a, b) => this.rank(a) - this.rank(b));
  }

  /** The library first, then notebooks, then the open page, then every other doc. */
  private rank(docId: string): number {
    if (docId === 'library') return 0;
    if (docId.startsWith('nb:')) return 1;
    if (docId === this.priorityDoc) return 2;
    return 3;
  }

  private pump(): void {
    while (!this.ended && this.running.size < HANDSHAKE_CONCURRENCY && this.queued.length > 0) {
      const docId = this.queued.shift()!;
      const timer = setTimeout(() => {
        this.docFailed(docId, 'protocol', new Error(`The server did not answer the handshake within ${this.docTimeoutMs} ms`));
      }, this.docTimeoutMs);
      this.running.set(docId, { diffApplied: false, diffSent: false, timer });
      void this.begin(docId);
    }
  }

  private async begin(docId: string): Promise<void> {
    try {
      this.held.add(docId);
      await this.replica.hold(docId);
      if (this.ended) return;
      await this.replica.withDoc(docId, (doc) => {
        this.send({ type: FrameType.StateVector, docId, payload: Y.encodeStateVector(doc) });
      });
    } catch (error) {
      this.docFailed(docId, 'store', error);
    }
  }

  private receiveFrame(frame: Frame): void {
    switch (frame.type) {
      case FrameType.StateVector:
        void this.answerStateVector(frame.docId, frame.payload);
        return;
      case FrameType.Diff:
        void this.applyDiff(frame.docId, frame.payload);
        return;
      case FrameType.Update:
        void this.applyUpdate(frame.docId, frame.payload);
        return;
    }
  }

  /**
   * Sends our Diff and marks the doc live in one step of the doc's queue, so
   * no stored change falls between them. The Diff includes whatever the store
   * holds that the loaded doc lacks, such as another tab's edits.
   */
  private async answerStateVector(docId: string, stateVector: Uint8Array): Promise<void> {
    const ownHold = !this.held.has(docId);
    try {
      if (ownHold) await this.replica.hold(docId);
      await this.replica.withStoredDoc(docId, (doc) => {
        if (this.ended) return;
        this.send({ type: FrameType.Diff, docId, payload: Y.encodeStateAsUpdate(doc, stateVector) });
        this.live.add(docId);
      });
    } catch (error) {
      this.docFailed(docId, 'store', error);
      return;
    } finally {
      if (ownHold) this.replica.unhold(docId);
    }
    if (this.ended) return;
    this.replica.markSent(docId);
    const handshake = this.running.get(docId);
    if (handshake === undefined) return;
    handshake.diffSent = true;
    this.finishIfDone(docId, handshake);
  }

  private async applyDiff(docId: string, diff: Uint8Array): Promise<void> {
    try {
      await this.replica.applyRemote(docId, diff);
    } catch (error) {
      this.docFailed(docId, 'protocol', error);
      return;
    }
    const handshake = this.running.get(docId);
    if (this.ended || handshake === undefined) return;
    handshake.diffApplied = true;
    this.finishIfDone(docId, handshake);
  }

  private async applyUpdate(docId: string, update: Uint8Array): Promise<void> {
    try {
      await this.replica.applyRemote(docId, update);
    } catch (error) {
      this.docFailed(docId, 'protocol', error);
    }
  }

  private finishIfDone(docId: string, handshake: Handshake): void {
    if (!handshake.diffApplied || !handshake.diffSent) return;
    clearTimeout(handshake.timer);
    this.running.delete(docId);
    if (this.held.delete(docId)) this.replica.unhold(docId);
    this.finished += 1;
    this.pump();
    this.events.onProgress();
  }

  /** Records the doc as failed for this session, ends its handshake if one runs, and moves on. */
  private docFailed(docId: string, kind: DocFailureKind, error: unknown): void {
    if (this.ended) return;
    const reason = error instanceof Error ? error : new Error(String(error));
    this.failed.set(docId, reason.message);
    const handshake = this.running.get(docId);
    if (handshake !== undefined) {
      clearTimeout(handshake.timer);
      this.running.delete(docId);
      if (this.held.delete(docId)) this.replica.unhold(docId);
      this.finished += 1;
      this.pump();
    }
    this.events.onDocFailed(docId, kind, new Error(`Doc "${docId}" could not be synced: ${reason.message}`));
    this.events.onProgress();
  }

  private send(frame: Frame): void {
    if (this.ended) return;
    this.socket.send(encodeFrame(frame));
  }

  private fail(kind: 'protocol' | 'store', error: unknown): void {
    if (this.ended) return;
    this.events.onFailure(kind, error instanceof Error ? error : new Error(String(error)));
  }
}

function toBytes(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  throw new Error(`Unexpected WebSocket message payload: ${Object.prototype.toString.call(data)}`);
}
