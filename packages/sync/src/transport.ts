/**
 * The parts of WebSocket and fetch the sync client uses. Browsers pass their
 * own globals unchanged; Node tests pass `ws` and Node's fetch. The package
 * builds without the DOM lib, so these shapes stand in for the DOM types.
 */

export interface SocketLike {
  binaryType: string;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export type SocketConstructor = new (url: string) => SocketLike;

export interface FetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: Uint8Array;
}

export interface FetchResponse {
  ok: boolean;
  status: number;
  statusText: string;
  arrayBuffer(): Promise<ArrayBuffer>;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export type FetchLike = (url: string, init?: FetchInit) => Promise<FetchResponse>;

/** The global WebSocket, typed for the client; throws when the environment has none. */
export function globalSocket(): SocketConstructor {
  const constructor = (globalThis as { WebSocket?: unknown }).WebSocket;
  if (typeof constructor !== 'function') {
    throw new Error('This environment has no global WebSocket; pass one in the SyncClient options');
  }
  return constructor as SocketConstructor;
}

/** The global fetch, typed for the client; throws when the environment has none. */
export function globalFetch(): FetchLike {
  const fetch = (globalThis as { fetch?: unknown }).fetch;
  if (typeof fetch !== 'function') {
    throw new Error('This environment has no global fetch; pass one in the SyncClient options');
  }
  return fetch.bind(globalThis) as FetchLike;
}
