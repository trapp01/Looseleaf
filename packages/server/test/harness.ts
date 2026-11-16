/**
 * Test helpers: a real server on an ephemeral port over a temporary data
 * folder, sync clients on in-memory stores using `ws`, a socket wrapper the
 * test can cut or block, convergence checks, and an MCP client.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, expect } from 'vitest';
import WebSocket from 'ws';
import * as Y from 'yjs';
import {
  decodeFrame,
  encodeFrame,
  encodeHello,
  MemoryStore,
  SyncClient,
  type Frame,
  type FrameType,
  type ClientStore,
  type FetchLike,
  type ReplicaStore,
  type SocketConstructor,
  type SyncClientOptions,
  type SyncStatus,
} from '@looseleaf/sync';
import { startServer, type RunningServer, type ServerOptions } from '../src/server.js';

export const TOKEN = 'test-token';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

export async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'looseleaf-test-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** A server that can be stopped and started again on the same port and data folder. */
export class TestServer {
  private running: RunningServer | null = null;
  private port = 0;

  private constructor(
    readonly dataDir: string,
    private readonly options: Partial<ServerOptions>,
  ) {}

  static async start(options: Partial<ServerOptions> = {}): Promise<TestServer> {
    const server = new TestServer(options.dataDir ?? (await tempDir()), options);
    await server.startAgain();
    cleanups.push(() => server.stop());
    return server;
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  get current(): RunningServer {
    if (this.running === null) throw new Error('The test server is stopped');
    return this.running;
  }

  async startAgain(): Promise<void> {
    this.running = await startServer({ token: TOKEN, ...this.options, dataDir: this.dataDir, port: this.port });
    this.port = this.running.port;
  }

  async stop(): Promise<void> {
    await this.running?.close();
    this.running = null;
  }

  /** The doc's state as the server stores it on disk. */
  async storedDoc(docId: string): Promise<Y.Doc> {
    return docFromStore(this.current.store, docId);
  }
}

/** Frames seen by a wrapped socket, decoded by the caller. */
export interface SocketEvents {
  sent?(data: string | Uint8Array): void;
  received?(data: Uint8Array, isBinary: boolean): void;
}

/** A `ws` WebSocket class for one client that the test can cut, block or watch. */
export class SocketControl {
  readonly sockets: WebSocket[] = [];
  /** While true, new sockets go to a closed port and fail to connect. */
  blocked = false;
  events: SocketEvents = {};
  readonly WebSocket: SocketConstructor;

  constructor() {
    const control = this;
    class ControlledSocket extends WebSocket {
      constructor(url: string) {
        super(control.blocked ? 'ws://127.0.0.1:9/sync' : url);
        control.sockets.push(this);
        this.on('message', (data, isBinary) => {
          // The client sets binaryType to arraybuffer, so binary data arrives as an ArrayBuffer.
          const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data as Buffer);
          control.events.received?.(bytes, isBinary);
        });
      }
      override send(data: string | Uint8Array): void {
        control.events.sent?.(data);
        super.send(data);
      }
    }
    this.WebSocket = ControlledSocket as unknown as SocketConstructor;
  }

  /** Drops every open socket at once, as a lost network would. */
  cutAll(): void {
    for (const socket of this.sockets) socket.terminate();
  }
}

export const nodeFetch = globalThis.fetch as unknown as FetchLike;

/** A client on its own in-memory store (or the one given), not yet connected. */
export async function makeClient<Store extends ClientStore = MemoryStore>(
  store: Store = new MemoryStore() as unknown as Store,
  control: SocketControl = new SocketControl(),
  options: Partial<SyncClientOptions> = {},
): Promise<{ client: SyncClient; store: Store; control: SocketControl }> {
  const client = await SyncClient.create({
    store,
    WebSocket: control.WebSocket,
    fetch: nodeFetch,
    reconnectDelayMs: { min: 10, max: 80 },
    ...options,
  });
  cleanups.push(() => client.close());
  return { client, store, control };
}

export async function connectedClient<Store extends ClientStore = MemoryStore>(
  server: TestServer,
  store?: Store,
  control?: SocketControl,
) {
  const made = await makeClient<Store>(store, control);
  await made.client.connect({ url: server.url, token: TOKEN });
  await waitForSynced(made.client);
  return made;
}

export async function waitFor(check: () => boolean | Promise<boolean>, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Resolves when the client next reports the state, even if it passes through it between polls. */
export function nextState(client: SyncClient, state: SyncStatus['state']): Promise<void> {
  return new Promise((resolve) => {
    const unsubscribe = client.onStatus((status) => {
      if (status.state !== state) return;
      unsubscribe();
      resolve();
    });
  });
}

export function waitForSynced(client: SyncClient, timeoutMs?: number): Promise<void> {
  return waitFor(
    () => client.status.state === 'synced',
    `synced (status is ${JSON.stringify(client.status)})`,
    timeoutMs,
  );
}

/** A fresh doc built from every update a store holds for the id. */
export async function docFromStore(store: ReplicaStore, docId: string): Promise<Y.Doc> {
  const doc = new Y.Doc();
  for (const update of await store.readUpdates(docId)) Y.applyUpdate(doc, update);
  return doc;
}

/** The parts of a test doc's content the tests write: text `t` and map `m`, its keys sorted. */
export function contentOf(doc: Y.Doc): { t: string; m: Record<string, unknown> } {
  const m = doc.getMap('m').toJSON();
  return { t: doc.getText('t').toString(), m: Object.fromEntries(Object.entries(m).sort(([a], [b]) => a.localeCompare(b))) };
}

/** True when the docs hold the same Yjs state: equal state vectors, delete sets and content. */
export function sameState(docs: Y.Doc[]): boolean {
  const [first, ...rest] = docs;
  if (first === undefined) return true;
  const vector = Buffer.from(Y.encodeStateVector(first)).toString('hex');
  const snapshot = Y.snapshot(first);
  const content = JSON.stringify(contentOf(first));
  return rest.every(
    (doc) =>
      Buffer.from(Y.encodeStateVector(doc)).toString('hex') === vector &&
      Y.equalSnapshots(Y.snapshot(doc), snapshot) &&
      JSON.stringify(contentOf(doc)) === content,
  );
}

/** Waits until every store and the server hold the same state for each doc, then returns that state per doc. */
export async function waitForConvergence(
  server: TestServer,
  stores: ReplicaStore[],
  docIds: string[],
  timeoutMs?: number,
): Promise<Map<string, Y.Doc>> {
  const converged = new Map<string, Y.Doc>();
  let difference = '';
  await waitFor(
    async () => {
      for (const docId of docIds) {
        const docs = [await server.storedDoc(docId), ...(await Promise.all(stores.map((s) => docFromStore(s, docId))))];
        if (!sameState(docs)) {
          difference = `${docId}: server, then each store: ${docs.map((doc) => JSON.stringify(contentOf(doc))).join(' | ')}`;
          return false;
        }
        converged.set(docId, docs[0]!);
      }
      return true;
    },
    `convergence of ${docIds.length} docs`,
    timeoutMs,
  ).catch((error: Error) => {
    throw new Error(`${error.message}; first difference ${difference}`);
  });
  return converged;
}

/** Opens a doc through the client, edits it and releases it. The edit is stored and sent in the background. */
export async function editDoc(client: SyncClient, docId: string, edit: (doc: Y.Doc) => void): Promise<void> {
  const doc = await client.openDoc(docId);
  edit(doc);
  client.releaseDoc(docId);
}

/** A bare protocol client: a socket past the welcome, with every binary frame it receives decoded. */
export async function rawSocket(server: TestServer): Promise<{ socket: WebSocket; frames: Frame[]; closedWith: () => number | null }> {
  const socket = new WebSocket(server.url.replace('http', 'ws') + '/sync');
  const frames: Frame[] = [];
  let closeCode: number | null = null;
  socket.on('close', (code) => {
    closeCode = code;
  });
  await new Promise((resolve) => socket.once('open', resolve));
  socket.send(encodeHello(TOKEN, 'raw'));
  await new Promise((resolve) => socket.once('message', resolve));
  socket.on('message', (data, isBinary) => {
    if (isBinary) frames.push(decodeFrame(new Uint8Array(data as Buffer)));
  });
  cleanups.push(async () => socket.terminate());
  return { socket, frames, closedWith: () => closeCode };
}

export function sendFrame(socket: WebSocket, type: FrameType, docId: string, payload: Uint8Array): void {
  socket.send(encodeFrame({ type, docId, payload }));
}

/** An MCP SDK client connected to the server's /mcp endpoint with the test token. */
export async function mcpClient(server: Pick<TestServer, 'url'>): Promise<Client> {
  const client = new Client({ name: 'looseleaf-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
  });
  await client.connect(transport);
  return client;
}

/** The text of a tool result and whether it is an error. */
export async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as Array<{ type: string; text: string }>;
  expect(content).toHaveLength(1);
  expect(content[0]!.type).toBe('text');
  return { text: content[0]!.text, isError: result.isError === true };
}

/** The updates a doc emits while `edit` runs, one per transaction. */
export function updatesOf(edit: (doc: Y.Doc) => void): Uint8Array[] {
  const doc = new Y.Doc();
  const updates: Uint8Array[] = [];
  doc.on('update', (update: Uint8Array) => updates.push(update));
  edit(doc);
  return updates;
}

export { expect };
