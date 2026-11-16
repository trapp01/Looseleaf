/**
 * The one object a UI talks to for sync. It hands out live Yjs docs backed by
 * the replica store, keeps a connection to the configured server (reconnecting
 * with backoff), runs a full handshake for every doc on each connect, mirrors
 * blobs, and publishes a status. It works the same with no server at all.
 */
import type * as Y from 'yjs';
import { BlobSync, type ServerAccess } from './blobs.js';
import { IndexedDbStore } from './indexeddb-store.js';
import { Listeners } from './listeners.js';
import { CLOSE_BAD_TOKEN, CLOSE_PROTOCOL_ERROR, normalizeServerAddress, socketUrl } from './protocol.js';
import { Replica } from './replica.js';
import type { ClientStore } from './replica-store.js';
import { Session } from './session.js';
import { sameStatus, type SyncError, type SyncErrorKind, type SyncState, type SyncStatus } from './sync-status.js';
import { globalFetch, globalSocket, type FetchLike, type SocketConstructor, type SocketLike } from './transport.js';

export const RECONNECT_MIN_DELAY_MS = 1000;
export const RECONNECT_MAX_DELAY_MS = 30_000;
/** A socket that opens but gets no welcome within this time is closed and retried. */
export const WELCOME_TIMEOUT_MS = 15_000;

const REPLICA_ID_SETTING = 'replicaId';
const SERVER_ADDRESS_SETTING = 'serverAddress';
const SERVER_TOKEN_SETTING = 'serverToken';
const LAST_SYNCED_SETTING = 'lastSyncedAt';

export interface SyncClientOptions {
  store: ClientStore;
  /** Defaults to the global WebSocket. Node callers pass `ws`. */
  WebSocket?: SocketConstructor;
  /** Defaults to the global fetch. */
  fetch?: FetchLike;
  /**
   * Backoff bounds for reconnecting and for retrying failed blob transfers;
   * each attempt waits a random time between half and all of the current bound.
   */
  reconnectDelayMs?: { min: number; max: number };
  /**
   * The BroadcastChannel name tabs sharing this store use to show each
   * other's edits at once. Defaults to one derived from the IndexedDB
   * database name for an IndexedDbStore and to none otherwise; null turns it
   * off. Ignored where BroadcastChannel does not exist.
   */
  tabChannel?: string | null;
  /** How long a doc's handshake may go unanswered before it is recorded as failed. */
  docHandshakeTimeoutMs?: number;
}

interface TabMessage {
  docId: string;
  update: Uint8Array;
}

interface TabChannel {
  postMessage(message: TabMessage): void;
  close(): void;
  onmessage: ((event: { data: TabMessage }) => void) | null;
}

export class SyncClient {
  private replica!: Replica;
  private blobs!: BlobSync;
  private replicaIdValue = '';
  private readonly Socket: SocketConstructor;
  private readonly delays: { min: number; max: number };
  private readonly listeners = new Set<(status: SyncStatus) => void>();
  private readonly docStored = new Listeners<string>();
  private readonly blobStored = new Listeners<string>();

  private access: ServerAccess | null = null;
  private socket: SocketLike | null = null;
  private session: Session | null = null;
  private socketOpened = false;
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private welcomeTimer: ReturnType<typeof setTimeout> | null = null;
  private nextRetryAt: number | null = null;
  private priorityDoc: string | null = null;
  private lastError: SyncError | null = null;
  /** The latest 'store' error, shown again after a welcome while the store still refuses changes. */
  private lastStoreError: SyncError | null = null;
  private lastSyncedAt: number | null = null;
  private wasInStep = false;
  private closed = false;
  private tabs: TabChannel | null = null;
  private current: SyncStatus;

  private constructor(private readonly options: SyncClientOptions) {
    this.Socket = options.WebSocket ?? globalSocket();
    this.delays = options.reconnectDelayMs ?? { min: RECONNECT_MIN_DELAY_MS, max: RECONNECT_MAX_DELAY_MS };
    this.current = this.computeStatus();
  }

  /**
   * Opens the client over a replica store. When the store remembers a server,
   * the client starts connecting to it at once; `connect` is not needed again
   * after a restart. Docs can be opened whether or not a server is reachable.
   */
  static async create(options: SyncClientOptions): Promise<SyncClient> {
    const client = new SyncClient(options);
    await client.init();
    return client;
  }

  private async init(): Promise<void> {
    const { store } = this.options;
    this.replica = await Replica.create(store, {
      onLocalChange: (docId, update) => {
        this.tabs?.postMessage({ docId, update });
        // With no server there is nothing to send to; the first handshake after connecting covers every doc.
        if (this.access === null) return;
        if (!this.session?.sendLocal(docId, update)) this.replica.markUnsent(docId);
      },
      onStoreError: (error) => this.setError('store', error.message),
      onCountsChange: () => {
        if (this.replica.unstoredCount() === 0 && this.lastError?.kind === 'store') this.lastError = null;
        this.updateStatus();
      },
      onStored: (docId) => this.docStored.emit(docId),
    });
    this.blobs = await BlobSync.create(
      store,
      this.options.fetch ?? globalFetch(),
      {
        onChange: () => this.updateStatus(),
        onError: (kind, error) => this.setError(kind, error.message),
        onStored: (hash) => this.blobStored.emit(hash),
      },
      this.delays,
    );
    this.tabs = this.openTabChannel();
    this.replicaIdValue = (await store.getSetting(REPLICA_ID_SETTING)) ?? (await this.saveNewReplicaId());
    const lastSynced = await store.getSetting(LAST_SYNCED_SETTING);
    this.lastSyncedAt = lastSynced === null ? null : Number(lastSynced);
    const address = await store.getSetting(SERVER_ADDRESS_SETTING);
    const token = await store.getSetting(SERVER_TOKEN_SETTING);
    if (address !== null && token !== null) {
      this.access = { address, token };
      this.blobs.setConfigured(this.access);
      this.openSocket();
    }
    this.updateStatus();
  }

  /** This device's replica id, sent in every hello. */
  get replicaId(): string {
    return this.replicaIdValue;
  }

  /** The current status. The same object is returned until the status changes. */
  get status(): SyncStatus {
    return this.current;
  }

  /** Calls `listener` after every status change (not immediately). Returns an unsubscribe function. */
  onStatus(listener: (status: SyncStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Calls `listener` with a doc's id after this client stores a change to it, made here or from the server. Returns unsubscribe. */
  onDocStored(listener: (docId: string) => void): () => void {
    return this.docStored.add(listener);
  }

  /** Calls `listener` with a blob's hash after this client stores it, put here or downloaded. Returns unsubscribe. */
  onBlobStored(listener: (hash: string) => void): () => void {
    return this.blobStored.add(listener);
  }

  /**
   * The live doc for an id, loaded from the replica store. Opening an id that
   * is already open returns the same instance. Local edits are stored before
   * they are sent. Call `releaseDoc` once per `openDoc` when done with it.
   */
  openDoc(docId: string): Promise<Y.Doc> {
    return this.replica.open(docId);
  }

  /** Releases one `openDoc` handle. Once none remain the doc is unloaded; it keeps syncing through the store. */
  releaseDoc(docId: string): void {
    this.replica.release(docId);
  }

  /** Names the doc the UI is showing, so its handshake runs right after the library's and notebooks'. */
  setPriorityDoc(docId: string | null): void {
    this.priorityDoc = docId;
    this.session?.prioritize(docId);
  }

  /**
   * Remembers the server in the replica store and connects to it, replacing
   * any earlier server or token. Resolves once the settings are saved, not when
   * connected; watch the status for that. Throws for an address that is not http(s).
   */
  async connect({ url, token }: { url: string; token: string }): Promise<void> {
    if (this.closed) throw new Error('Cannot connect: the sync client is closed');
    const address = normalizeServerAddress(url);
    if (token.trim() === '') throw new Error('An access token is required to connect to a server');
    await this.options.store.setSetting(SERVER_ADDRESS_SETTING, address);
    await this.options.store.setSetting(SERVER_TOKEN_SETTING, token.trim());
    this.access = { address, token: token.trim() };
    this.blobs.setConfigured(this.access);
    this.lastError = null;
    this.restart();
  }

  /** Closes the connection and forgets the server. The replica keeps working on its own. */
  async disconnect(): Promise<void> {
    this.access = null;
    this.blobs.setConfigured(null);
    this.stopConnection();
    this.lastError = null;
    await this.options.store.setSetting(SERVER_ADDRESS_SETTING, null);
    await this.options.store.setSetting(SERVER_TOKEN_SETTING, null);
    this.updateStatus();
  }

  /** Skips the backoff wait and tries the server now, e.g. when the device comes back online. */
  retryNow(): void {
    if (this.closed || this.access === null || this.socket !== null) return;
    this.restart();
  }

  /** Stores the blob locally, uploads it when connected, and resolves to its SHA-256 hex. */
  putBlob(bytes: Uint8Array): Promise<string> {
    return this.blobs.put(bytes);
  }

  /** The blob's bytes from the replica, else fetched from the server and kept; null when neither has it. */
  getBlob(hash: string): Promise<Uint8Array | null> {
    return this.blobs.get(hash);
  }

  /**
   * Resolves once every change made so far, to any doc or blob, is in the
   * replica store. Rejects, naming the docs, when the store still refuses some
   * changes; nothing is closed and those writes keep retrying.
   */
  async flush(): Promise<void> {
    await this.blobs.flushed();
    await this.replica.flush();
  }

  /**
   * Stops syncing, waits for queued store writes and unloads every doc. The
   * server stays remembered. Rejects, naming the docs, when the replica store
   * still refuses some changes.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.stopConnection();
    this.tabs?.close();
    this.tabs = null;
    try {
      await this.replica.close();
    } finally {
      await this.blobs.close();
      this.listeners.clear();
      this.docStored.clear();
      this.blobStored.clear();
    }
  }

  /** Opens the channel tabs sharing the store use for each other's stored edits, when the environment has one. */
  private openTabChannel(): TabChannel | null {
    const { store, tabChannel } = this.options;
    const name = tabChannel !== undefined ? tabChannel : store instanceof IndexedDbStore ? `looseleaf:${store.name}` : null;
    const Channel = (globalThis as unknown as { BroadcastChannel?: new (name: string) => TabChannel }).BroadcastChannel;
    if (name === null || Channel === undefined) return null;
    const channel = new Channel(name);
    channel.onmessage = ({ data }) => {
      void this.replica.applyFromOtherTab(data.docId, data.update).catch((error: unknown) => {
        this.setError('store', `Could not show another tab's change to doc "${data.docId}": ${String(error)}`);
      });
    };
    return channel;
  }

  private restart(): void {
    this.stopConnection();
    this.attempt = 0;
    this.openSocket();
  }

  private openSocket(): void {
    const access = this.access;
    if (this.closed || access === null) return;
    this.nextRetryAt = null;
    let socket: SocketLike;
    try {
      socket = new this.Socket(socketUrl(access.address));
    } catch (error) {
      this.setError('unreachable', `Could not open a connection to ${access.address}: ${String(error)}`);
      this.scheduleReconnect();
      return;
    }
    socket.binaryType = 'arraybuffer';
    const session = new Session(
      socket,
      this.replica,
      {
        onWelcome: () => this.handleWelcome(socket, access),
        onProgress: () => this.updateStatus(),
        onDocFailed: (_docId, kind, error) => this.setError(kind, error.message),
        onFailure: (kind, error) => {
          this.setError(kind, error.message);
          this.dropSocket(socket, { reconnect: true });
        },
      },
      this.priorityDoc,
      this.options.docHandshakeTimeoutMs,
    );
    this.socket = socket;
    this.session = session;
    this.socketOpened = false;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.socketOpened = true;
      session.sendHello(access.token, this.replicaIdValue);
      this.welcomeTimer = setTimeout(() => {
        this.setError('protocol', `${access.address} accepted the connection but sent no welcome`);
        this.dropSocket(socket, { reconnect: true });
      }, WELCOME_TIMEOUT_MS);
    };
    socket.onmessage = (event) => {
      if (this.socket === socket) session.receive(event.data);
    };
    socket.onclose = (event) => this.handleClose(socket, access, event.code, event.reason);
    // A close event always follows an error event; handleClose reports it.
    socket.onerror = () => undefined;
    this.updateStatus();
  }

  private handleWelcome(socket: SocketLike, access: ServerAccess): void {
    if (this.socket !== socket) return;
    this.clearWelcomeTimer();
    this.attempt = 0;
    // A store that still refuses writes is still a problem after reconnecting.
    this.lastError = this.replica.unstoredCount() > 0 ? this.lastStoreError : null;
    this.blobs.goOnline(access);
    this.updateStatus();
  }

  private handleClose(socket: SocketLike, access: ServerAccess, code: number, reason: string): void {
    if (this.socket !== socket) return;
    const opened = this.socketOpened;
    this.detachSocket();
    if (code === CLOSE_BAD_TOKEN) {
      this.setError('bad-token', `The server at ${access.address} refused the access token`);
      return;
    }
    if (code === CLOSE_PROTOCOL_ERROR) {
      this.setError('protocol', `The server at ${access.address} closed the connection: ${reason}`);
    } else if (opened) {
      this.setError('unreachable', `Lost the connection to ${access.address} (code ${code})`);
    } else {
      this.setError('unreachable', `Could not reach ${access.address}`);
    }
    this.scheduleReconnect();
  }

  /** Abandons the socket now, without waiting for its close event. */
  private dropSocket(socket: SocketLike, { reconnect }: { reconnect: boolean }): void {
    if (this.socket !== socket) return;
    this.detachSocket();
    closeQuietly(socket);
    if (reconnect) this.scheduleReconnect();
  }

  private stopConnection(): void {
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.nextRetryAt = null;
    if (this.socket !== null) this.dropSocket(this.socket, { reconnect: false });
  }

  private detachSocket(): void {
    this.clearWelcomeTimer();
    this.session?.end();
    this.session = null;
    this.socket = null;
    this.socketOpened = false;
    this.blobs.goOffline();
    this.updateStatus();
  }

  private scheduleReconnect(): void {
    if (this.closed || this.access === null || this.retryTimer !== null) return;
    const bound = Math.min(this.delays.max, this.delays.min * 2 ** this.attempt);
    const delay = bound / 2 + (Math.random() * bound) / 2;
    this.attempt += 1;
    this.nextRetryAt = Date.now() + delay;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.openSocket();
    }, delay);
    this.updateStatus();
  }

  private clearWelcomeTimer(): void {
    if (this.welcomeTimer !== null) clearTimeout(this.welcomeTimer);
    this.welcomeTimer = null;
  }

  private setError(kind: SyncErrorKind, message: string): void {
    this.lastError = { kind, message, at: Date.now() };
    if (kind === 'store') this.lastStoreError = this.lastError;
    this.updateStatus();
  }

  private updateStatus(): void {
    if (this.replica === undefined || this.blobs === undefined) return;
    const inStep = this.isInStep();
    // Entering or leaving step both mark the last moment the replica was known in step.
    if (inStep !== this.wasInStep) {
      this.lastSyncedAt = Date.now();
      this.options.store.setSetting(LAST_SYNCED_SETTING, String(this.lastSyncedAt)).catch((error: unknown) => {
        this.setError('store', `Could not save the last synced time: ${String(error)}`);
      });
    }
    this.wasInStep = inStep;
    const next = this.computeStatus();
    if (sameStatus(next, this.current)) return;
    this.current = next;
    for (const listener of this.listeners) listener(next);
  }

  private computeStatus(): SyncStatus {
    const session = this.session;
    const progress = session?.isWelcomed ? session.progress : { done: 0, total: 0 };
    let state: SyncState;
    if (this.access === null) state = 'no-server';
    else if (session === null) state = 'offline';
    else if (!session.isWelcomed) state = 'connecting';
    else if (this.isInStep()) state = 'synced';
    else state = 'syncing';
    return {
      state,
      server: this.access?.address ?? null,
      docsDone: progress.done,
      docsTotal: progress.total,
      lastError: this.lastError,
      lastSyncedAt: this.lastSyncedAt,
      nextRetryAt: this.nextRetryAt,
      unsentDocs: this.replica?.unsentCount() ?? 0,
      unsentBlobs: this.blobs?.unsentCount ?? 0,
      unstoredDocs: this.replica?.unstoredCount() ?? 0,
      failedDocs: session?.failedDocs ?? [],
    };
  }

  /** In step: every handshake finished, every blob transferred, nothing unsent or unstored. */
  private isInStep(): boolean {
    return (
      (this.session?.isInStep ?? false) &&
      this.blobs.isMirrored &&
      this.blobs.unsentCount === 0 &&
      this.replica.unsentCount() === 0 &&
      this.replica.unstoredCount() === 0
    );
  }

  private async saveNewReplicaId(): Promise<string> {
    const id = newReplicaId();
    await this.options.store.setSetting(REPLICA_ID_SETTING, id);
    return id;
  }
}

function closeQuietly(socket: SocketLike): void {
  socket.onopen = null;
  socket.onmessage = null;
  socket.onclose = null;
  // Some socket implementations report an error when closed while connecting; keep a listener for it.
  socket.onerror = () => undefined;
  try {
    socket.close(1000, 'client closed the connection');
  } catch (error) {
    // A socket still connecting can refuse close() in some runtimes; it is already detached.
    console.warn('Closing the sync socket failed', error);
  }
}

/** 16 random bytes as hex. `getRandomValues` exists on plain-http origins, unlike `randomUUID`. */
function newReplicaId(): string {
  const crypto = (globalThis as { crypto?: { getRandomValues(bytes: Uint8Array): Uint8Array } }).crypto;
  if (crypto === undefined) throw new Error('This environment has no crypto.getRandomValues to make a replica id');
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
