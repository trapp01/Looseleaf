/**
 * Media types for pictures and attached files: sniffed from the first bytes
 * when the format has a signature, otherwise taken from the file extension.
 */

const startsWith = (data: Uint8Array, bytes: number[], at = 0): boolean =>
  data.length >= at + bytes.length && bytes.every((b, i) => data[at + i] === b);

const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));

/** The media type a file's signature identifies, or undefined when it has none this knows. */
export function sniffMime(data: Uint8Array): string | undefined {
  if (startsWith(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(data, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(data, ascii('GIF87a')) || startsWith(data, ascii('GIF89a'))) return 'image/gif';
  if (startsWith(data, ascii('RIFF')) && startsWith(data, ascii('WEBP'), 8)) return 'image/webp';
  if (startsWith(data, ascii('BM'))) return 'image/bmp';
  if (startsWith(data, [0x49, 0x49, 0x2a, 0x00]) || startsWith(data, [0x4d, 0x4d, 0x00, 0x2a])) return 'image/tiff';
  // EMF: an EMR_HEADER record (type 1) whose signature at offset 40 reads " EMF".
  if (startsWith(data, [0x01, 0x00, 0x00, 0x00]) && startsWith(data, [0x20, 0x45, 0x4d, 0x46], 40)) return 'image/emf';
  // WMF: a placeable header, or a bare METAHEADER (memory or disk type, header size 9 words).
  if (startsWith(data, [0xd7, 0xcd, 0xc6, 0x9a])) return 'image/wmf';
  if (startsWith(data, [0x01, 0x00, 0x09, 0x00]) || startsWith(data, [0x02, 0x00, 0x09, 0x00])) return 'image/wmf';
  if (startsWith(data, ascii('%PDF-'))) return 'application/pdf';
  if (startsWith(data, [0x50, 0x4b, 0x03, 0x04])) return 'application/zip';
  return undefined;
}

const BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  emf: 'image/emf',
  wmf: 'image/wmf',
  webp: 'image/webp',
  pdf: 'application/pdf',
  txt: 'text/plain',
  csv: 'text/csv',
  html: 'text/html',
  htm: 'text/html',
  zip: 'application/zip',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  wma: 'audio/x-ms-wma',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  wmv: 'video/x-ms-wmv',
  avi: 'video/x-msvideo',
  mpg: 'video/mpeg',
};

/**
 * The media type for a file: its signature when recognised, else its extension
 * (with or without the leading dot, any case), else application/octet-stream.
 * Office formats are zip files, so a known extension wins over a zip signature.
 */
export function mimeFor(data: Uint8Array, extensionOrName = ''): string {
  const extension = /([^./\\]+)$/.exec(extensionOrName.toLowerCase())?.[1] ?? '';
  const fromExtension = BY_EXTENSION[extension];
  const sniffed = sniffMime(data);
  if (sniffed === 'application/zip' && fromExtension) return fromExtension;
  return sniffed ?? fromExtension ?? 'application/octet-stream';
}

/** Picture formats a browser displays directly. */
export function isBrowserImage(mime: string): boolean {
  return ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp'].includes(mime);
}
