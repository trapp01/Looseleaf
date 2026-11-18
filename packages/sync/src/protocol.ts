/**
 * The wire protocol between a replica and the server: the WebSocket text
 * frames that open a session, the binary frames that carry Yjs state, the
 * close codes, and the HTTP routes. This module is the only place that knows
 * the byte layout; see "Wire protocol" in docs/architecture.md.
 */
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';

export const PROTOCOL_VERSION = 1;

/**
 * The doc content a client can hold without damaging it: the rich-text nodes
 * and attributes its schema keeps. Raise it whenever docs gain something an
 * older client's editor would delete or strip, since those deletions sync to
 * every device. The server refuses a client below its own content version.
 */
export const CONTENT_VERSION = 2;

/** Paths the server answers on. The client joins them onto the server address. */
export const SYNC_PATH = '/sync';
export const INFO_PATH = '/api/info';
export const HEALTH_PATH = '/api/health';
export const BLOBS_PATH = '/api/blobs';

/** The server closes the socket with this code when the hello's token is wrong. */
export const CLOSE_BAD_TOKEN = 4401;
/** The server closes with this code on a malformed frame or an unsupported protocol version. */
export const CLOSE_PROTOCOL_ERROR = 4400;
/** The server closes with this code when the hello's content version is below the server's. */
export const CLOSE_CLIENT_TOO_OLD = 4426;
/** The close reason sent with a content-version refusal. A close reason holds at most 123 bytes. */
export const CLIENT_TOO_OLD_REASON = 'This app is older than the server. Reload the page or restart the app to update.';

export enum FrameType {
  /** The sender's state vector. The receiver replies with a Diff. */
  StateVector = 0,
  /** Everything the sender has that the received state vector lacks. */
  Diff = 1,
  /** One incremental update, forwarded as it happens. */
  Update = 2,
}

export interface Frame {
  type: FrameType;
  docId: string;
  payload: Uint8Array;
}

export interface Hello {
  t: 'hello';
  token: string;
  replica: string;
  v: number;
  /** The client's content version (see CONTENT_VERSION); builds older than the field send none. */
  content?: number;
}

export interface Welcome {
  t: 'welcome';
  /** Every doc id the server holds. */
  docs: string[];
}

/** What `GET /api/info` returns. The connect screen uses it to check an address. */
export interface ServerInfo {
  name: 'looseleaf';
  version: string;
  protocol: number;
}

/** What `GET /api/blobs` returns: the hash of every blob the server holds. */
export interface BlobList {
  blobs: string[];
}

/**
 * Checks a server address such as `http://nas:8421` (a path prefix is kept)
 * and returns it without a trailing slash. Throws for anything but http(s).
 */
export function normalizeServerAddress(address: string): string {
  let url: URL;
  try {
    url = new URL(address.trim());
  } catch {
    throw new Error(`"${address}" is not a server address; expected something like http://nas:8421`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Server address "${address}" must start with http:// or https://`);
  }
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/+$/, '');
}

/** The URL of one of the server's HTTP routes, from a normalized address. */
export function routeUrl(address: string, path: string): string {
  return `${address}${path}`;
}

/** The sync WebSocket URL, from a normalized address: ws:// for http, wss:// for https. */
export function socketUrl(address: string): string {
  return routeUrl(address.replace(/^http/, 'ws'), SYNC_PATH);
}

/** Binary frame layout: [varuint type][varstring docId][payload to the end of the frame]. */
export function encodeFrame(frame: Frame): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, frame.type);
  encoding.writeVarString(encoder, frame.docId);
  encoding.writeUint8Array(encoder, frame.payload);
  return encoding.toUint8Array(encoder);
}

/** Throws a descriptive error for a truncated frame, an unknown type or an empty doc id. */
export function decodeFrame(bytes: Uint8Array): Frame {
  const decoder = decoding.createDecoder(bytes);
  let type: number;
  let docId: string;
  try {
    type = decoding.readVarUint(decoder);
    docId = decoding.readVarString(decoder);
  } catch (error) {
    throw new Error(`Malformed sync frame of ${bytes.length} bytes: ${String(error)}`);
  }
  if (type !== FrameType.StateVector && type !== FrameType.Diff && type !== FrameType.Update) {
    throw new Error(`Unknown sync frame type ${type} for doc "${docId}"`);
  }
  if (docId === '') {
    throw new Error(`Sync frame of type ${FrameType[type]} has an empty doc id`);
  }
  return { type, docId, payload: decoding.readTailAsUint8Array(decoder) };
}

export function encodeHello(token: string, replica: string): string {
  const hello: Hello = { t: 'hello', token, replica, v: PROTOCOL_VERSION, content: CONTENT_VERSION };
  return JSON.stringify(hello);
}

/** Throws when the text is not a hello; the versions are returned as sent so the caller can refuse them. */
export function decodeHello(text: string): Hello {
  const value = parseJson(text, 'hello');
  if (
    value.t !== 'hello' ||
    typeof value.token !== 'string' ||
    typeof value.replica !== 'string' ||
    typeof value.v !== 'number' ||
    (value.content !== undefined && typeof value.content !== 'number')
  ) {
    throw new Error(`Expected a hello frame, got ${text.slice(0, 200)}`);
  }
  const hello: Hello = { t: 'hello', token: value.token, replica: value.replica, v: value.v };
  if (typeof value.content === 'number') hello.content = value.content;
  return hello;
}

/**
 * How the server refuses a hello whose content version is below its own, or
 * null when the client may sync. Builds that send no content version know
 * only CLOSE_PROTOCOL_ERROR, which they show with its reason and retry with
 * backoff, so they get that code; later builds get CLOSE_CLIENT_TOO_OLD.
 */
export function contentRefusal(hello: Hello): { code: number; reason: string } | null {
  if (hello.content !== undefined && hello.content >= CONTENT_VERSION) return null;
  const code = hello.content === undefined ? CLOSE_PROTOCOL_ERROR : CLOSE_CLIENT_TOO_OLD;
  return { code, reason: CLIENT_TOO_OLD_REASON };
}

export function encodeWelcome(docs: string[]): string {
  const welcome: Welcome = { t: 'welcome', docs };
  return JSON.stringify(welcome);
}

export function decodeWelcome(text: string): Welcome {
  const value = parseJson(text, 'welcome');
  const docs = value.docs;
  if (value.t !== 'welcome' || !Array.isArray(docs) || !docs.every((id) => typeof id === 'string')) {
    throw new Error(`Expected a welcome frame, got ${text.slice(0, 200)}`);
  }
  return { t: 'welcome', docs: docs as string[] };
}

function parseJson(text: string, expected: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`Expected a ${expected} frame, got text that is not JSON: ${text.slice(0, 200)}`);
  }
  if (typeof value !== 'object' || value === null) {
    throw new Error(`Expected a ${expected} frame, got ${text.slice(0, 200)}`);
  }
  return value as Record<string, unknown>;
}
