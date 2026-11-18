/**
 * The pixel size of a PNG, GIF, JPEG or WebP picture, read from its header,
 * for placing a picture whose size nothing recorded. Null for any other
 * bytes, so the caller can show the file as an attachment instead.
 */
export function imageSize(bytes: Uint8Array): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (start: number, length: number) => String.fromCharCode(...bytes.subarray(start, start + length));
  const size = (width: number, height: number) => (width > 0 && height > 0 ? { width, height } : null);
  if (bytes.length >= 24 && ascii(1, 3) === 'PNG' && ascii(12, 4) === 'IHDR') return size(view.getUint32(16), view.getUint32(20));
  if (bytes.length >= 10 && ascii(0, 4) === 'GIF8') return size(view.getUint16(6, true), view.getUint16(8, true));
  if (bytes.length >= 30 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return webpSize(bytes, view, ascii(12, 4));
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) return jpegSize(bytes, view);
  return null;
}

function webpSize(bytes: Uint8Array, view: DataView, chunk: string): { width: number; height: number } | null {
  if (chunk === 'VP8X') return { width: 1 + read24(bytes, 24), height: 1 + read24(bytes, 27) };
  if (chunk === 'VP8L') {
    const bits = view.getUint32(21, true);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8 ') return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
  return null;
}

function read24(bytes: Uint8Array, at: number): number {
  return bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16);
}

/** Walks the JPEG segments to the first start-of-frame marker, which holds the size. */
function jpegSize(bytes: Uint8Array, view: DataView): { width: number; height: number } | null {
  let at = 2;
  while (at + 9 <= bytes.length) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1]!;
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      const height = view.getUint16(at + 5);
      const width = view.getUint16(at + 7);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    at += 2 + view.getUint16(at + 2);
  }
  return null;
}
