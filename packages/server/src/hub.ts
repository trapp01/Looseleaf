/**
 * The sync endpoint: the server side of the handshake in "Wire protocol".
 * It answers each client state vector with a Diff and its own state vector,
 * and for every Diff or Update stores what the doc did not already have
 * before relaying exactly that to the other connected clients. Server code
 * changes a doc through `withDoc`, which stores and relays the same way. Docs
 * are held in memory while in use and evicted, least recently used first. A
 * doc that cannot be read, stored or applied is logged and skipped for that
 * frame; the connection and every other doc carry on, and the client's next
 * handshake offers the doc again.
 */
import type { WebSocket } from 'ws';
import * as Y from 'yjs';
import {
  CLOSE_BAD_TOKEN,
  CLOSE_PROTOCOL_ERROR,
  CONTENT_VERSION,
  contentRefusal,
  decodeFrame,
  decodeHello,
  encodeFrame,
  encodeWelcome,
  FrameType,
  hasPendingUpdates,
  isReadableUpdate,
  KeyedQueue,
  PROTOCOL_VERSION,
  type Frame,
} from '@looseleaf/sync';
import { tokenMatches } from './access-token.js';
import type { DiskStore } from './disk-store.js';

/** Loaded docs kept in memory; past this the least recently used idle ones are dropped. */
export const DOC_CACHE_SIZE = 500;
/** A doc's snapshot is rewritten once its log holds more than this many records. */
export const LOG_COMPACT_AFTER_RECORDS = 200;
/** A socket that sends no hello within this time is closed. */
export const HELLO_TIMEOUT_MS = 10_000;
/** Sockets are pinged this often and closed when a ping goes unanswered. */
export const PING_INTERVAL_MS = 30_000;

const CLOSE_GOING_AWAY = 1001;
const CLOSE_INTERNAL_ERROR = 1011;
const OPEN = 1;

interface Connection {
  readonly socket: WebSocket;
  readonly remote: string;
  welcomed: boolean;
  replica: string;
  answeredPing: boolean;
}

interface CachedDoc {
  doc: Y.Doc;
  /** Updates in the store for this doc: the snapshot plus log records. */
  storedCount: number;
}

export interface HubOptions {
  docCacheSize?: number;
  /** Called with a doc's id each time an update to it is on disk. It must not throw or block. */
  onDocStored?: (docId: string) => void;
}

export class Hub {
  private readonly connections = new Set<Connection>();
  private readonly docs = new Map<string, CachedDoc>();
  private readonly queue = new KeyedQueue();
  private readonly docCacheSize: number;
  private readonly onDocStored: ((docId: string) => void) | undefined;
  private readonly pingTimer: ReturnType<typeof setInterval>;
  private closing = false;

  constructor(
    private readonly store: DiskStore,
    private readonly token: string,
    options: HubOptions = {},
  ) {
    this.docCacheSize = options.docCacheSize ?? DOC_CACHE_SIZE;
    this.onDocStored = options.onDocStored;
    this.pingTimer = setInterval(() => this.pingAll(), PING_INTERVAL_MS);
    this.pingTimer.unref();
  }

  get loadedDocCount(): number {
    return this.docs.size;
  }

  /** Takes over a socket that has just been upgraded on the sync path. */
  accept(socket: WebSocket, remote: string): void {
    if (this.closing) {
      socket.close(CLOSE_GOING_AWAY, 'server shutting down');
      return;
    }
    const connection: Connection = { socket, remote, welcomed: false, replica: '', answeredPing: true };
    this.connections.add(connection);
    const helloTimer = setTimeout(() => {
      if (!connection.welcomed) this.refuse(connection, CLOSE_PROTOCOL_ERROR, 'no hello received');
    }, HELLO_TIMEOUT_MS);
    socket.on('message', (data, isBinary) => {
      const bytes = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
      if (isBinary) this.receiveFrame(connection, bytes);
      else void this.receiveHello(connection, bytes.toString('utf8'));
    });
    socket.on('pong', () => {
      connection.answeredPing = true;
    });
    socket.on('close', () => {
      clearTimeout(helloTimer);
      this.connections.delete(connection);
    });
    socket.on('error', (error) => {
      console.warn(`Sync socket error from ${remote}: ${error.message}`);
    });
  }

  /**
   * Runs `change` on the doc inside one transaction, in the doc's queue, then
   * stores what it changed and relays that to every connected client, as an
   * update from a client would be. A change that writes nothing stores and
   * sends nothing, so a read-only callback is fine. Resolves with what
   * `change` returned. Throws, leaving disk and memory as they were, when
   * `change` throws or the store refuses the update, and when the hub is closing.
   */
  async withDoc<T>(docId: string, change: (doc: Y.Doc) => T): Promise<T> {
    if (this.closing) throw new Error(`The server is shutting down; doc "${docId}" was not changed`);
    try {
      return await this.queue.run(docId, async () => {
        const cached = await this.loadDoc(docId);
        const changes: Uint8Array[] = [];
        const collect = (update: Uint8Array) => changes.push(update);
        cached.doc.on('update', collect);
        let result: T;
        try {
          result = cached.doc.transact(() => change(cached.doc));
          if (changes.length > 0) {
            const update = changes.length === 1 ? changes[0]! : Y.mergeUpdates(changes);
            await this.storeChange(docId, cached, update);
            this.relay(null, docId, update);
          }
        } catch (error) {
          this.dropDoc(docId);
          throw error;
        } finally {
          cached.doc.off('update', collect);
        }
        await this.compactWhenLong(docId, cached);
        return result;
      });
    } finally {
      this.evictIdleDocs();
    }
  }

  /** Closes every socket, then waits for every update already received to be stored. */
  async close(): Promise<void> {
    this.closing = true;
    clearInterval(this.pingTimer);
    for (const connection of this.connections) {
      connection.socket.close(CLOSE_GOING_AWAY, 'server shutting down');
    }
    await this.queue.drain();
  }

  private async receiveHello(connection: Connection, text: string): Promise<void> {
    if (connection.welcomed) {
      this.refuse(connection, CLOSE_PROTOCOL_ERROR, 'unexpected text frame after the welcome');
      return;
    }
    let hello;
    try {
      hello = decodeHello(text);
    } catch (error) {
      this.refuse(connection, CLOSE_PROTOCOL_ERROR, (error as Error).message);
      return;
    }
    if (hello.v !== PROTOCOL_VERSION) {
      const reason = `protocol version ${hello.v} is not supported; this server speaks ${PROTOCOL_VERSION}`;
      this.refuse(connection, CLOSE_PROTOCOL_ERROR, reason);
      return;
    }
    const tooOld = contentRefusal(hello);
    if (tooOld !== null) {
      console.warn(`Refused a sync connection from ${connection.remote}: content version ${hello.content ?? 'none'} is below ${CONTENT_VERSION}`);
      this.refuse(connection, tooOld.code, tooOld.reason);
      return;
    }
    if (!tokenMatches(hello.token, this.token)) {
      console.warn(`Refused a sync connection from ${connection.remote}: wrong access token`);
      this.refuse(connection, CLOSE_BAD_TOKEN, 'bad token');
      return;
    }
    connection.replica = hello.replica;
    let docs: string[];
    try {
      docs = await this.store.listDocs();
    } catch (error) {
      console.error('Could not list docs for a welcome', error);
      this.refuse(connection, CLOSE_INTERNAL_ERROR, 'server could not list its docs');
      return;
    }
    connection.welcomed = true;
    this.send(connection, encodeWelcome(docs));
  }

  private receiveFrame(connection: Connection, bytes: Uint8Array): void {
    if (!connection.welcomed) {
      this.refuse(connection, CLOSE_PROTOCOL_ERROR, 'binary frame before the hello');
      return;
    }
    let frame: Frame;
    try {
      frame = decodeFrame(bytes);
    } catch (error) {
      this.refuse(connection, CLOSE_PROTOCOL_ERROR, (error as Error).message);
      return;
    }
    void this.queue
      .run(frame.docId, () =>
        frame.type === FrameType.StateVector
          ? this.answerStateVector(connection, frame)
          : this.storeAndRelay(connection, frame),
      )
      .catch((error: unknown) => {
        // The client still holds whatever failed here; its next handshake offers it again.
        console.error(`Skipped a ${FrameType[frame.type]} frame for doc "${frame.docId}" from ${connection.remote}`, error);
      })
      .finally(() => this.evictIdleDocs());
  }

  private async answerStateVector(connection: Connection, frame: Frame): Promise<void> {
    const { docId } = frame;
    const { doc } = await this.loadDoc(docId);
    this.send(connection, encodeFrame({ type: FrameType.Diff, docId, payload: Y.encodeStateAsUpdate(doc, frame.payload) }));
    this.send(connection, encodeFrame({ type: FrameType.StateVector, docId, payload: Y.encodeStateVector(doc) }));
  }

  /**
   * Applies the update, stores what was new to the doc, relays that, then
   * compacts the log when it is long. Throws, leaving disk and memory as they
   * were, for an update that does not decode or cannot be applied or stored.
   */
  private async storeAndRelay(from: Connection, frame: Frame): Promise<void> {
    const { docId } = frame;
    if (!isReadableUpdate(frame.payload)) throw new Error(`The update for doc "${docId}" does not decode`);
    const cached = await this.loadDoc(docId);
    const changes: Uint8Array[] = [];
    const collect = (update: Uint8Array) => changes.push(update);
    cached.doc.on('update', collect);
    try {
      Y.applyUpdate(cached.doc, frame.payload);
      const change = changes.length === 0 ? null : changes.length === 1 ? changes[0]! : Y.mergeUpdates(changes);
      if (change !== null) await this.storeChange(docId, cached, change);
      // The part waiting on a missing dependency is in no update event; keep the raw update so it survives.
      if (hasPendingUpdates(cached.doc)) await this.storeChange(docId, cached, frame.payload);
      if (change !== null) this.relay(from, docId, change);
    } catch (error) {
      // Memory may now hold what the disk does not; the next use reloads from disk.
      this.dropDoc(docId);
      throw error;
    } finally {
      cached.doc.off('update', collect);
    }
    await this.compactWhenLong(docId, cached);
  }

  private async compactWhenLong(docId: string, cached: CachedDoc): Promise<void> {
    if (cached.storedCount <= LOG_COMPACT_AFTER_RECORDS) return;
    try {
      await this.store.compact(docId);
      cached.storedCount = 1;
    } catch (error) {
      console.error(`Could not compact doc "${docId}"; its log keeps growing until a compaction succeeds`, error);
    }
  }

  private async storeChange(docId: string, cached: CachedDoc, update: Uint8Array): Promise<void> {
    await this.store.appendUpdate(docId, update);
    cached.storedCount += 1;
    try {
      this.onDocStored?.(docId);
    } catch (error) {
      console.error(`A listener for stored updates failed on doc "${docId}"; the update is stored`, error);
    }
  }

  /** Sends the change to every welcomed client except `from`, the one it came from (null for a change made here). */
  private relay(from: Connection | null, docId: string, change: Uint8Array): void {
    const frame = encodeFrame({ type: FrameType.Update, docId, payload: change });
    for (const connection of this.connections) {
      if (connection !== from && connection.welcomed) this.send(connection, frame);
    }
  }

  private dropDoc(docId: string): void {
    const cached = this.docs.get(docId);
    if (cached === undefined) return;
    this.docs.delete(docId);
    cached.doc.destroy();
  }

  /** The doc from memory or disk. Runs inside the doc's queue. */
  private async loadDoc(docId: string): Promise<CachedDoc> {
    const cached = this.docs.get(docId);
    if (cached !== undefined) {
      this.docs.delete(docId);
      this.docs.set(docId, cached);
      return cached;
    }
    const updates = await this.store.readUpdates(docId);
    const doc = new Y.Doc();
    try {
      if (updates.length > 0) Y.applyUpdate(doc, Y.mergeUpdates(updates));
    } catch (error) {
      doc.destroy();
      throw error;
    }
    const loaded = { doc, storedCount: updates.length };
    this.docs.set(docId, loaded);
    return loaded;
  }

  private evictIdleDocs(): void {
    if (this.docs.size <= this.docCacheSize) return;
    for (const [docId, cached] of this.docs) {
      if (this.docs.size <= this.docCacheSize) return;
      if (this.queue.busy(docId)) continue;
      this.docs.delete(docId);
      cached.doc.destroy();
    }
  }

  private send(connection: Connection, data: string | Uint8Array): void {
    if (connection.socket.readyState === OPEN) connection.socket.send(data);
  }

  private refuse(connection: Connection, code: number, reason: string): void {
    // Close reasons are limited to 123 bytes.
    connection.socket.close(code, reason.slice(0, 120));
  }

  private pingAll(): void {
    for (const connection of this.connections) {
      if (!connection.answeredPing) {
        connection.socket.terminate();
        continue;
      }
      connection.answeredPing = false;
      connection.socket.ping();
    }
  }
}
