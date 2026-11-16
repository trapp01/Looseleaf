/**
 * The server's HTTP routes: info and health (no auth), blob list, download
 * and upload (bearer token), the MCP endpoint at /mcp (bearer token; the
 * protocol is in `mcp.ts`), and the web client's static files for every
 * other path. Every response allows any origin; the token is the gate.
 * Every response also forbids MIME sniffing.
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import {
  BLOBS_PATH,
  HEALTH_PATH,
  INFO_PATH,
  isBlobHash,
  PROTOCOL_VERSION,
  type BlobList,
  type ServerInfo,
} from '@looseleaf/sync';
import { bearerToken, tokenMatches } from './access-token.js';
import { BlobHashMismatchError, BlobTooLargeError, type DiskStore } from './disk-store.js';
import { isNotFound } from './doc-log.js';
import { answerMcp, MCP_PATH } from './mcp.js';
import type { MirrorView } from './mirror.js';

export interface HttpOptions {
  store: DiskStore;
  token: string;
  version: string;
  maxBlobBytes: number;
  /** A folder holding the built web client with an index.html, or null to serve a plain-text notice. */
  webDir: string | null;
  /** The running mirror the MCP endpoint reads, or null when the mirror is off and /mcp answers 404. */
  mirror: MirrorView | null;
  /** Called with a blob's hash after an upload stores a blob that was not stored before. It must not throw or block. */
  onBlobStored?: (hash: string) => void;
}

const NO_WEB_CLIENT =
  'Looseleaf server is running. This build has no web client; open it from the desktop app, or set LOOSELEAF_WEB_DIR.\n';

/** Sent with the web client's HTML. connect-src is wide because the client may sync with another Looseleaf server. */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "font-src 'self' data:",
  "connect-src 'self' ws: wss: http: https:",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'self'",
].join('; ');

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
};

/** Builds the request handler. Errors inside a route answer 500 and are logged with the route. */
export function createHttpHandler(options: HttpOptions): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    allowAnyOrigin(req, res);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    handle(options, req, res).catch((error: unknown) => {
      console.error(`${req.method} ${req.url} failed`, error);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal server error' });
      else res.destroy();
    });
  };
}

async function handle(options: HttpOptions, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = new URL(req.url ?? '/', 'http://server').pathname;
  const method = req.method ?? 'GET';
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Methods': 'GET, HEAD, PUT, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept, Mcp-Protocol-Version, Mcp-Session-Id',
      'Access-Control-Max-Age': '86400',
    });
    res.end();
    return;
  }
  if (path === INFO_PATH && method === 'GET') {
    const info: ServerInfo = { name: 'looseleaf', version: options.version, protocol: PROTOCOL_VERSION };
    return sendJson(res, 200, info);
  }
  if (path === HEALTH_PATH && method === 'GET') return sendJson(res, 200, { ok: true });
  if (path === BLOBS_PATH || path.startsWith(`${BLOBS_PATH}/`)) return handleBlobs(options, req, res, path, method);
  if (path === MCP_PATH) return handleMcp(options, req, res, method);
  if (path.startsWith('/api/')) return sendJson(res, 404, { error: `no route ${method} ${path}` });
  if (method !== 'GET' && method !== 'HEAD') return sendJson(res, 405, { error: `${method} is not allowed here` });
  return serveWebClient(options.webDir, req, res, path);
}

async function handleBlobs(
  options: HttpOptions,
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  method: string,
): Promise<void> {
  const token = bearerToken(req.headers.authorization);
  if (token === null || !tokenMatches(token, options.token)) {
    return sendJson(res, 401, { error: 'missing or wrong access token' });
  }
  if (path === BLOBS_PATH) {
    if (method !== 'GET') return sendJson(res, 405, { error: `${method} is not allowed on ${BLOBS_PATH}` });
    const list: BlobList = { blobs: await options.store.listBlobs() };
    return sendJson(res, 200, list);
  }
  const hash = path.slice(BLOBS_PATH.length + 1);
  if (!isBlobHash(hash)) return sendJson(res, 400, { error: `"${hash}" is not a lowercase SHA-256 hex hash` });
  if (method === 'GET' || method === 'HEAD') {
    const blob = await options.store.openBlob(hash);
    if (blob === null) return sendJson(res, 404, { error: `no blob ${hash}` });
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': 'attachment',
      'Content-Length': String(blob.size),
      'Cache-Control': 'private, max-age=31536000, immutable',
    });
    if (method === 'HEAD') {
      blob.stream.destroy();
      res.end();
      return;
    }
    await pipeline(blob.stream, res);
    return;
  }
  if (method === 'PUT') return receiveBlob(options, req, res, hash);
  return sendJson(res, 405, { error: `${method} is not allowed on a blob` });
}

async function handleMcp(options: HttpOptions, req: IncomingMessage, res: ServerResponse, method: string): Promise<void> {
  if (options.mirror === null) {
    return sendJson(res, 404, { error: 'the MCP endpoint needs the mirror, which is off; set LOOSELEAF_MIRROR=on (or leave it unset) and restart' });
  }
  if (method !== 'POST') {
    // No SSE stream and no sessions, so GET and DELETE have nothing to do.
    res.setHeader('Allow', 'POST');
    return sendJson(res, 405, { error: `${method} is not allowed on ${MCP_PATH}; send JSON-RPC messages with POST` });
  }
  const token = bearerToken(req.headers.authorization);
  if (token === null || !tokenMatches(token, options.token)) {
    return sendJson(res, 401, { error: 'missing or wrong access token' });
  }
  const reply = await answerMcp(req, options.mirror, options.version);
  for (const [name, value] of Object.entries(reply.headers ?? {})) res.setHeader(name, value);
  if (reply.body === null) {
    res.writeHead(reply.status);
    res.end();
    return;
  }
  return sendJson(res, reply.status, reply.body);
}

async function receiveBlob(options: HttpOptions, req: IncomingMessage, res: ServerResponse, hash: string): Promise<void> {
  const declared = Number(req.headers['content-length'] ?? NaN);
  if (declared > options.maxBlobBytes) {
    // Answer before reading the body and close, so a large upload stops early.
    res.setHeader('Connection', 'close');
    return sendJson(res, 413, { error: `blob is larger than the ${options.maxBlobBytes}-byte limit` });
  }
  try {
    const created = await options.store.putBlobStream(hash, req, options.maxBlobBytes);
    if (created) {
      try {
        options.onBlobStored?.(hash);
      } catch (error) {
        console.error(`A listener for stored blobs failed on blob ${hash}; the blob is stored`, error);
      }
    }
    return sendJson(res, created ? 201 : 200, { blob: hash });
  } catch (error) {
    if (error instanceof BlobHashMismatchError) return sendJson(res, 400, { error: error.message });
    if (error instanceof BlobTooLargeError) {
      res.setHeader('Connection', 'close');
      return sendJson(res, 413, { error: error.message });
    }
    throw error;
  }
}

/**
 * Serves a file from the web client. A missing path with a file extension is a
 * 404; any other missing path is a navigation and gets index.html.
 */
async function serveWebClient(webDir: string | null, req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  if (webDir === null) {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(NO_WEB_CLIENT);
    return;
  }
  let relative: string;
  try {
    relative = decodeURIComponent(path);
  } catch {
    return sendJson(res, 400, { error: 'malformed path' });
  }
  const root = resolve(webDir);
  const candidate = resolve(join(root, relative));
  const inside = candidate === root || candidate.startsWith(root + sep);
  const file = inside ? await fileSize(candidate) : null;
  if (file === null && extname(relative) !== '') return sendJson(res, 404, { error: `no file ${relative}` });
  const target = file === null ? join(root, 'index.html') : candidate;
  const size = file ?? (await fileSize(target));
  if (size === null) return sendJson(res, 404, { error: 'the web client has no index.html' });
  // Bundled assets carry a content hash in their name; everything else must be revalidated.
  const immutable = file !== null && relative.startsWith('/assets/');
  const extension = extname(target).toLowerCase();
  res.writeHead(200, {
    'Content-Type': CONTENT_TYPES[extension] ?? 'application/octet-stream',
    'Content-Length': String(size),
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    ...(extension === '.html' ? { 'Content-Security-Policy': CONTENT_SECURITY_POLICY } : {}),
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  await pipeline(createReadStream(target), res);
}

/** The size of a regular file, or null when the path is missing or not a file. */
async function fileSize(path: string): Promise<number | null> {
  try {
    const info = await stat(path);
    return info.isFile() ? info.size : null;
  } catch (error) {
    if (isNotFound(error) || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return null;
    throw error;
  }
}

function allowAnyOrigin(req: IncomingMessage, res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  // Chrome asks before a public or app:// origin may reach a private-network address.
  if (req.headers['access-control-request-private-network'] === 'true') {
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}
