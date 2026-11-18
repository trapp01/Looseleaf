/**
 * The open page: its doc, its notebook, and the one undo history for it.
 * Undo covers text edits in every container (they arrive with y-prosemirror's
 * origin) and container and stroke changes made through the model (no
 * origin); changes from the server or the replica store, and board changes
 * made through `replicaDocAccess`, are never undone.
 * Local edits also bump the page's modified time, at most once a minute: at
 * the first edit, then once more when the minute ends (or the page closes) if
 * edits came in meanwhile.
 */
import * as Y from 'yjs';
import { ySyncPluginKey } from 'y-prosemirror';
import { touchNode } from '@looseleaf/model';
import { Store } from '../app/store.js';

const TOUCH_INTERVAL_MS = 60_000;

export class PageSession {
  readonly undo: Y.UndoManager;
  /** Bumped whenever the undo or redo stack changes, for button state. */
  readonly history = new Store(0);
  private lastTouch = 0;
  private trailingTouch: ReturnType<typeof setTimeout> | null = null;
  /** Ids of the page's To Do lines that are in its board's Inbox and show an "Inbox" pill; board/page-inbox.ts fills it. */
  readonly inbox = new Store<ReadonlySet<string>>(new Set());
  /** The lowest edge of the page's content in canvas px; the canvas supplies it while mounted. */
  contentBottom: () => number = () => 0;

  constructor(
    readonly notebookId: string,
    readonly pageId: string,
    readonly doc: Y.Doc,
    private readonly notebookDoc: Y.Doc,
  ) {
    this.undo = new Y.UndoManager([doc.getMap('containers'), doc.getMap('strokes'), doc.getMap('meta')], {
      trackedOrigins: new Set<unknown>([null, ySyncPluginKey]),
      captureTimeout: 600,
    });
    const bump = () => this.history.update((n) => n + 1);
    this.undo.on('stack-item-added', bump);
    this.undo.on('stack-item-popped', bump);
    this.undo.on('stack-cleared', bump);
    doc.on('afterTransaction', this.onTransaction);
  }

  /** Runs a model write as its own undo step, never merged with typing just before or after it. */
  step<T>(write: () => T): T {
    this.undo.stopCapturing();
    const result = write();
    this.undo.stopCapturing();
    return result;
  }

  /**
   * Runs a model write that should not be undoable on its own, and drops the
   * history entry `since` left behind (e.g. an empty container's creation
   * when the container is cleaned up again).
   */
  runUntracked(write: () => void, since?: unknown): void {
    this.doc.transact(write, 'cleanup');
    const stack = this.undo.undoStack;
    if (since !== undefined && stack[stack.length - 1] === since) {
      stack.pop();
      this.history.update((n) => n + 1);
    }
  }

  /** The newest undo entry, to hand to `runUntracked` later. */
  lastEntry(): unknown {
    this.undo.stopCapturing();
    return this.undo.undoStack[this.undo.undoStack.length - 1];
  }

  destroy(): void {
    this.doc.off('afterTransaction', this.onTransaction);
    if (this.trailingTouch) this.touch();
    this.undo.destroy();
  }

  private readonly onTransaction = (tr: Y.Transaction) => {
    if (!tr.local || tr.origin === 'cleanup' || tr.changed.size === 0) return;
    const wait = this.lastTouch + TOUCH_INTERVAL_MS - Date.now();
    if (wait <= 0) this.touch();
    else this.trailingTouch ??= setTimeout(() => this.touch(), wait);
  };

  private touch(): void {
    if (this.trailingTouch) clearTimeout(this.trailingTouch);
    this.trailingTouch = null;
    this.lastTouch = Date.now();
    touchNode(this.notebookDoc, this.pageId);
  }
}
