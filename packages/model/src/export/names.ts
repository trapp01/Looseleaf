/** File and folder names for exports: safe on every common file system and unique within a folder. */

const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;
const MAX_LENGTH = 100;

/** A name with characters that file systems reject replaced, trimmed and shortened. */
export function sanitizeName(name: string, fallback: string): string {
  let clean = name
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+|\.+$/g, '')
    .trim();
  if (clean.length > MAX_LENGTH) clean = clean.slice(0, MAX_LENGTH).trim();
  if (clean === '') clean = fallback;
  if (RESERVED.test(clean)) clean += '_';
  return clean;
}

/**
 * Hands out names within one folder, adding " (2)", " (3)" … to repeats.
 * Comparison ignores case, since macOS and Windows do.
 */
export class NameAllocator {
  private readonly used = new Set<string>();

  take(base: string, extension = ''): string {
    for (let n = 1; ; n++) {
      const candidate = n === 1 ? `${base}${extension}` : `${base} (${n})${extension}`;
      if (!this.used.has(candidate.toLowerCase())) {
        this.used.add(candidate.toLowerCase());
        return candidate;
      }
    }
  }
}

const MIME_EXTENSIONS: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'image/bmp': '.bmp',
  'image/tiff': '.tiff',
  'application/pdf': '.pdf',
  'text/plain': '.txt',
};

/**
 * The asset file name for a blob: its hash plus an extension from the
 * original name or the mime type. The same blob always gets the same name.
 */
export function assetFileName(hash: string, mime: string, name: string): string {
  const fromName = /\.([a-z0-9]{1,8})$/i.exec(name)?.[0];
  return hash + (fromName ?? MIME_EXTENSIONS[mime] ?? '').toLowerCase();
}
