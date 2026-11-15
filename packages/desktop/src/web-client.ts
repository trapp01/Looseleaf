/**
 * Where the web client comes from: the `app://looseleaf` origin, the folder of
 * built files behind it, and which URLs count as the app. Knows nothing about
 * Electron so the path rules can be tested in Node.
 */
import { stat } from 'node:fs/promises';
import { extname, join } from 'node:path';

export const APP_SCHEME = 'app';
export const APP_HOST = 'looseleaf';
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
export const APP_URL = `${APP_ORIGIN}/`;

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
};

export function contentTypeFor(file: string): string {
  return CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * The file under `root` that a URL path names, or null when the path cannot name
 * one. `..`, `.` and empty segments are dropped, so the result is always inside
 * `root`. Percent-escapes are decoded first, so `%2e%2e` and `%2f` get the same rule.
 */
export function webFilePath(root: string, urlPathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const segments = decoded.split(/[\\/]/).filter((s) => s !== '' && s !== '.' && s !== '..');
  if (segments.some((s) => s.includes(':'))) return null;
  return segments.length === 0 ? null : join(root, ...segments);
}

/**
 * The file to serve for a URL path: the named file when it exists, otherwise
 * `index.html` so the web client's own routes load. Null when the folder has no
 * `index.html`, which means the web client has not been built.
 */
export async function findWebFile(root: string, urlPathname: string): Promise<string | null> {
  const named = webFilePath(root, urlPathname);
  if (named && (await isFile(named))) return named;
  const index = join(root, 'index.html');
  return (await isFile(index)) ? index : null;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** `scheme://host[:port]` of a URL. Node gives non-http schemes an origin of "null", so it is built by hand. */
export function originOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.host ? `${parsed.protocol}//${parsed.host}` : null;
  } catch {
    return null;
  }
}

/** True when `url` belongs to the app: the app:// origin, or the development server's origin when one is set. */
export function isAppUrl(url: string, devUrl?: string): boolean {
  const origin = originOf(url);
  if (origin === null) return false;
  return origin === APP_ORIGIN || (devUrl !== undefined && origin === originOf(devUrl));
}
