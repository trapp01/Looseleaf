/**
 * Blobs between a replica and the server over HTTP. A blob is stored locally
 * first and uploaded while a session is welcomed. Each welcome mirrors both
 * ways against the server's list: upload what it lacks, download what the
 * replica lacks. A failed transfer mirrors again after a backoff delay while
 * the session lasts. Every downloaded blob is checked against its hash.
 */
import {
  BLOBS_PATH,
  INFO_PATH,
  normalizeServerAddress,
  PROTOCOL_VERSION,
  routeUrl,
  type BlobList,
  type ServerInfo,
} from './protocol.js';
import { PersistedIdSet } from './persisted-id-set.js';
import { blobHash, isBlobHash, type ClientStore } from './replica-store.js';
import { globalFetch, type FetchLike, type FetchResponse } from './transport.js';

/** At most this many blob uploads and mirror downloads run at once; an on-demand `get` does not wait behind them. */
export const BLOB_TRANSFER_CONCURRENCY = 4;
const UNSENT_BLOBS_SETTING = 'unsentBlobs';

/** Backoff bounds for mirroring again after a failed transfer. */
export interface RetryDelays {
  min: number;
  max: number;
}

/** A server address (normalized) and its access token. */
export interface ServerAccess {
  address: string;
  token: string;
}

export interface BlobSyncEvents {
  /** The unsent count or the mirror state changed. */
  onChange(): void;
  /** A blob, put here or downloaded, has been written to the store. */
  onStored(hash: string): void;
  onError(kind: 'bad-token' | 'blob' | 'store', error: Error): void;
}

export class BlobSync {
  /** The server blobs go to while a session is welcomed; null otherwise. */
  private online: ServerAccess | null = null;
  /** The configured server, used to fetch a missing blob on demand. */
  private configured: ServerAccess | null = null;
  /** Bumped whenever the online server changes, so a mirror for an old session stops. */
  private generation = 0;
  private mirrored = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryAttempt = 0;
  private readonly fetching = new Map<string, Promise<Uint8Array | null>>();
  /** Blob writes to the store that have not settled yet. */
  private readonly storing = new Set<Promise<void>>();
  /** Shared by the mirror and by `put`, so all uploads and mirror downloads together stay within the limit. */
  private readonly transfers = new Limiter(BLOB_TRANSFER_CONCURRENCY);

  private constructor(
    private readonly store: ClientStore,
    private readonly fetch: FetchLike,
    private readonly events: BlobSyncEvents,
    private readonly unsent: PersistedIdSet,
    private readonly retryDelays: RetryDelays,
  ) {}

  static async create(
    store: ClientStore,
    fetch: FetchLike,
    events: BlobSyncEvents,
    retryDelays: RetryDelays,
  ): Promise<BlobSync> {
    const unsent = await PersistedIdSet.load(store, UNSENT_BLOBS_SETTING, (error) => events.onError('store', error));
    return new BlobSync(store, fetch, events, unsent, retryDelays);
  }

  get unsentCount(): number {
    return this.unsent.size;
  }

  /** True once a mirror in this session has finished with every transfer done. */
  get isMirrored(): boolean {
    return this.online !== null && this.mirrored;
  }

  setConfigured(access: ServerAccess | null): void {
    this.configured = access;
  }

  /** A session was welcomed: start mirroring with that server. */
  goOnline(access: ServerAccess): void {
    this.goOffline();
    this.online = access;
    this.retryAttempt = 0;
    void this.mirror(access, this.generation);
  }

  goOffline(): void {
    this.generation += 1;
    this.online = null;
    this.mirrored = false;
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  /** Stores the bytes locally, uploads them when online, and resolves to their hash once stored. */
  async put(bytes: Uint8Array): Promise<string> {
    const hash = await this.storeBlob(bytes);
    // With no server there is nothing to send to; the mirror after connecting finds every blob.
    if (this.configured === null) return hash;
    if (this.unsent.add(hash)) this.events.onChange();
    const online = this.online;
    if (online !== null) {
      const generation = this.generation;
      void this.transfers.run(() => this.upload(online, hash, generation)).then((done) => {
        if (!done) this.retryLater(online, generation);
      });
    }
    return hash;
  }

  /**
   * The blob's bytes from the replica, or else from the configured server
   * (then kept in the replica). Null when neither has it or the server cannot
   * be reached. Concurrent calls for one hash share one request.
   */
  async get(hash: string): Promise<Uint8Array | null> {
    if (!isBlobHash(hash)) throw new Error(`"${hash}" is not a blob hash (64 lowercase hex characters)`);
    const local = await this.store.getBlob(hash);
    if (local !== null) return local;
    const access = this.configured;
    if (access === null) return null;
    const pending = this.fetching.get(hash);
    if (pending !== undefined) return pending;
    const request = this.download(access, hash, { quietWhenUnreachable: this.online === null }).finally(() => {
      this.fetching.delete(hash);
    });
    this.fetching.set(hash, request);
    return request;
  }

  private async mirror(access: ServerAccess, generation: number): Promise<void> {
    let serverHashes: Set<string>;
    let localHashes: string[];
    try {
      const response = await this.request(access, 'GET', BLOBS_PATH);
      if (response === null) return;
      serverHashes = new Set(((await response.json()) as BlobList).blobs);
      localHashes = await this.store.listBlobs();
    } catch (error) {
      if (generation === this.generation) {
        this.events.onError('blob', asError(error));
        this.retryLater(access, generation);
      }
      return;
    }
    if (generation !== this.generation) return;
    const localSet = new Set(localHashes);
    const toUpload = localHashes.filter((hash) => !serverHashes.has(hash));
    const toDownload = [...serverHashes].filter((hash) => isBlobHash(hash) && !localSet.has(hash));
    this.unsent.replace(toUpload);
    this.events.onChange();
    let failures = 0;
    await Promise.all(
      toUpload.map((hash) =>
        this.transfers.run(async () => {
          if (!(await this.upload(access, hash, generation))) failures += 1;
        }),
      ),
    );
    await Promise.all(
      toDownload.map((hash) =>
        this.transfers.run(async () => {
          if (generation !== this.generation) return;
          if ((await this.download(access, hash, { quietWhenUnreachable: false })) === null) failures += 1;
        }),
      ),
    );
    if (generation !== this.generation) return;
    if (failures > 0) {
      this.retryLater(access, generation);
      return;
    }
    this.retryAttempt = 0;
    this.mirrored = true;
    this.events.onChange();
  }

  /** Mirrors again after the next backoff delay, unless the session has ended or a retry is already due. */
  private retryLater(access: ServerAccess, generation: number): void {
    if (generation !== this.generation || this.retryTimer !== null) return;
    const bound = Math.min(this.retryDelays.max, this.retryDelays.min * 2 ** this.retryAttempt);
    this.retryAttempt += 1;
    this.retryTimer = setTimeout(
      () => {
        this.retryTimer = null;
        if (generation === this.generation) void this.mirror(access, generation);
      },
      bound / 2 + (Math.random() * bound) / 2,
    );
  }

  /**
   * Uploads one stored blob. Resolves to false when the upload failed and is
   * worth retrying. A stored blob whose bytes no longer match its name is
   * reported and dropped from the unsent set, since no retry can fix it.
   */
  private async upload(access: ServerAccess, hash: string, generation: number): Promise<boolean> {
    if (generation !== this.generation) return true;
    try {
      const bytes = await this.store.getBlob(hash);
      if (bytes === null || blobHash(bytes) !== hash) {
        this.events.onError('store', new Error(`Blob ${hash} in the replica store is missing or damaged; it cannot be uploaded`));
        if (this.unsent.delete(hash)) this.events.onChange();
        return true;
      }
      const response = await this.request(access, 'PUT', `${BLOBS_PATH}/${hash}`, bytes);
      if (response === null) return false;
      if (this.unsent.delete(hash)) this.events.onChange();
      return true;
    } catch (error) {
      if (generation === this.generation) this.events.onError('blob', asError(error));
      return false;
    }
  }

  private async download(
    access: ServerAccess,
    hash: string,
    { quietWhenUnreachable }: { quietWhenUnreachable: boolean },
  ): Promise<Uint8Array | null> {
    let bytes: Uint8Array;
    try {
      const response = await this.request(access, 'GET', `${BLOBS_PATH}/${hash}`, undefined, { allowNotFound: true });
      if (response === null || response.status === 404) return null;
      bytes = new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      if (!quietWhenUnreachable) this.events.onError('blob', asError(error));
      return null;
    }
    if (blobHash(bytes) !== hash) {
      this.events.onError('blob', new Error(`The server sent bytes for blob ${hash} that do not match its hash`));
      return null;
    }
    try {
      await this.storeBlob(bytes);
    } catch (error) {
      this.events.onError('store', new Error(`Could not store downloaded blob ${hash}: ${String(error)}`));
    }
    return bytes;
  }

  /**
   * One authorized request. Resolves to null after reporting a bad token,
   * throws with the route and status for any other failure.
   */
  private async request(
    access: ServerAccess,
    method: 'GET' | 'PUT',
    path: string,
    body?: Uint8Array,
    { allowNotFound = false } = {},
  ): Promise<FetchResponse | null> {
    const url = routeUrl(access.address, path);
    const headers: Record<string, string> = { Authorization: `Bearer ${access.token}` };
    if (body !== undefined) headers['Content-Type'] = 'application/octet-stream';
    let response: FetchResponse;
    try {
      response = await this.fetch(url, { method, headers, body });
    } catch (error) {
      throw new Error(`${method} ${url} failed: ${String(error)}`);
    }
    if (response.status === 401) {
      this.events.onError('bad-token', new Error(`The server refused the access token for ${method} ${url}`));
      return null;
    }
    if (response.ok || (allowNotFound && response.status === 404)) return response;
    const detail = (await response.text().catch(() => '')).slice(0, 200);
    throw new Error(`${method} ${url} answered ${response.status} ${response.statusText} ${detail}`.trim());
  }

  /** Writes the bytes to the store, tracked so `flushed` can wait for the write. */
  private storeBlob(bytes: Uint8Array): Promise<string> {
    const write = this.store.putBlob(bytes).then((hash) => {
      this.events.onStored(hash);
      return hash;
    });
    const settled = write.then(
      () => undefined,
      () => undefined,
    );
    this.storing.add(settled);
    void settled.then(() => this.storing.delete(settled));
    return write;
  }

  /** Resolves once every blob write started so far and every queued settings write has settled. */
  async flushed(): Promise<void> {
    while (this.storing.size > 0) await Promise.all(this.storing);
    await this.unsent.flushed();
  }

  /** Goes offline and resolves once pending store and settings writes have settled. */
  async close(): Promise<void> {
    this.goOffline();
    await this.flushed();
  }
}

/** Runs at most `limit` tasks at once; the others wait in the order they arrived. */
class Limiter {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly limit: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active < this.limit) this.active += 1;
    else await new Promise<void>((resolve) => this.waiting.push(resolve));
    try {
      return await task();
    } finally {
      // Hand the slot straight to the next waiting task, or free it.
      const next = this.waiting.shift();
      if (next !== undefined) next();
      else this.active -= 1;
    }
  }
}

/**
 * Asks an address whether a Looseleaf server answers there, for a connect
 * screen. Resolves to its info; throws a message fit to show when nothing
 * answers, something else answers, or it speaks another protocol version.
 */
export async function fetchServerInfo(address: string, fetch: FetchLike = globalFetch()): Promise<ServerInfo> {
  const base = normalizeServerAddress(address);
  const url = routeUrl(base, INFO_PATH);
  let response: FetchResponse;
  try {
    response = await fetch(url);
  } catch (error) {
    throw new Error(`Could not reach ${base}: ${String(error)}`);
  }
  const info = response.ok ? ((await response.json().catch(() => null)) as Partial<ServerInfo> | null) : null;
  if (info === null || info.name !== 'looseleaf') {
    throw new Error(`${base} answered, but it is not a Looseleaf server`);
  }
  if (info.protocol !== PROTOCOL_VERSION) {
    throw new Error(
      `The server at ${base} speaks sync protocol ${String(info.protocol)}; this app speaks ${PROTOCOL_VERSION}`,
    );
  }
  return { name: 'looseleaf', version: String(info.version), protocol: info.protocol };
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
