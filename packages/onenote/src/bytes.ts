/**
 * Bounds-checked little-endian reading over one file's bytes, plus the
 * [MS-ONESTORE] 2.2 common types: GUID, ExtendedGUID, CompactID and the file
 * chunk references. Every read past the end throws a `FormatError` carrying the
 * offset, so a corrupt length can never read outside the buffer.
 */

/** A structure in the file is malformed. `offset` is the file offset where reading failed. */
export class FormatError extends Error {
  constructor(
    message: string,
    readonly offset: number,
  ) {
    super(`${message} (at byte ${offset})`);
    this.name = 'FormatError';
  }
}

/**
 * An ExtendedGUID ([MS-ONESTORE] 2.2.1) as a string key: lowercase GUID, a
 * slash, then n. Object, object space, context and revision ids all use it.
 */
export type ExGuid = string;

export const NIL_GUID = '00000000-0000-0000-0000-000000000000';
export const NIL_EXGUID: ExGuid = `${NIL_GUID}/0`;

export function exGuid(guid: string, n: number): ExGuid {
  return `${guid}/${n}`;
}

/** A reference to `cb` bytes at file offset `stp` ([MS-ONESTORE] 2.2.4). */
export interface ChunkRef {
  stp: number;
  cb: number;
}

export class ByteReader {
  private readonly view: DataView;
  pos: number;

  /** Reads `bytes[start, end)`; offsets in errors and `pos` are relative to `bytes`. */
  constructor(
    readonly bytes: Uint8Array,
    start = 0,
    readonly end = bytes.length,
  ) {
    if (start < 0 || end > bytes.length || start > end) {
      throw new FormatError(`Range ${start}..${end} lies outside ${bytes.length} bytes`, start);
    }
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.pos = start;
  }

  get remaining(): number {
    return this.end - this.pos;
  }

  private need(n: number): number {
    const at = this.pos;
    if (n < 0 || at + n > this.end) {
      throw new FormatError(`Needed ${n} bytes but only ${this.end - at} remain`, at);
    }
    this.pos = at + n;
    return at;
  }

  u8(): number {
    return this.view.getUint8(this.need(1));
  }

  u16(): number {
    return this.view.getUint16(this.need(2), true);
  }

  u32(): number {
    return this.view.getUint32(this.need(4), true);
  }

  i32(): number {
    return this.view.getInt32(this.need(4), true);
  }

  f32(): number {
    return this.view.getFloat32(this.need(4), true);
  }

  /** An unsigned 64-bit integer. Values past 2^53 lose precision; callers range-check them. */
  u64(): number {
    const at = this.need(8);
    return this.view.getUint32(at, true) + this.view.getUint32(at + 4, true) * 0x1_0000_0000;
  }

  /** A view of the next `n` bytes, without copying. */
  take(n: number): Uint8Array {
    const at = this.need(n);
    return this.bytes.subarray(at, at + n);
  }

  skip(n: number): void {
    this.need(n);
  }

  /** A GUID ([MS-DTYP] 2.3.4) as a lowercase string without braces. */
  guid(): string {
    return formatGuid(this.take(16));
  }

  extendedGuid(): ExGuid {
    const guid = this.guid();
    return exGuid(guid, this.u32());
  }

  /** A FileChunkReference64x32 ([MS-ONESTORE] 2.2.4.4); null for fcrNil. */
  chunkRef64x32(): ChunkRef | null {
    const lo = this.u32();
    const hi = this.u32();
    const cb = this.u32();
    if (lo === 0xffffffff && hi === 0xffffffff) return null;
    return { stp: lo + hi * 0x1_0000_0000, cb };
  }

  /** A FileChunkReference32 ([MS-ONESTORE] 2.2.4.1); null for fcrNil. */
  chunkRef32(): ChunkRef | null {
    const stp = this.u32();
    const cb = this.u32();
    return stp === 0xffffffff ? null : { stp, cb };
  }

  /**
   * A FileNodeChunkReference ([MS-ONESTORE] 2.2.4.2) whose field widths come
   * from the FileNode header. Compressed values are multiplied by 8. Null for
   * fcrNil (every stp bit set).
   */
  fileNodeChunkRef(stpFormat: number, cbFormat: number): ChunkRef | null {
    let stp: number;
    let nil: boolean;
    switch (stpFormat) {
      case 0: {
        const at = this.pos;
        const lo = this.u32();
        const hi = this.u32();
        nil = lo === 0xffffffff && hi === 0xffffffff;
        stp = lo + hi * 0x1_0000_0000;
        if (!nil && hi > 0x1fffff) throw new FormatError('File pointer is too large', at);
        break;
      }
      case 1:
        stp = this.u32();
        nil = stp === 0xffffffff;
        break;
      case 2:
        stp = this.u16();
        nil = stp === 0xffff;
        stp *= 8;
        break;
      default:
        stp = this.u32();
        nil = stp === 0xffffffff;
        stp *= 8;
        break;
    }
    let cb: number;
    switch (cbFormat) {
      case 0:
        cb = this.u32();
        break;
      case 1:
        cb = this.u64();
        break;
      case 2:
        cb = this.u8() * 8;
        break;
      default:
        cb = this.u16() * 8;
        break;
    }
    return nil ? null : { stp, cb };
  }
}

const HEX: string[] = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

/** Formats 16 bytes in [MS-DTYP] GUID layout: the first three fields are little-endian. */
export function formatGuid(b: Uint8Array): string {
  const h = (i: number): string => HEX[b[i] ?? 0] ?? '00';
  return (
    h(3) + h(2) + h(1) + h(0) + '-' + h(5) + h(4) + '-' + h(7) + h(6) + '-' +
    h(8) + h(9) + '-' + h(10) + h(11) + h(12) + h(13) + h(14) + h(15)
  );
}

/** A CompactID ([MS-ONESTORE] 2.2.2): `n` is the low 8 bits, `guidIndex` the high 24. */
export function splitCompactId(value: number): { n: number; guidIndex: number } {
  return { n: value & 0xff, guidIndex: value >>> 8 };
}

/** Decodes UTF-16LE, stopping at the first NUL. Odd trailing bytes are dropped. */
export function decodeUtf16(bytes: Uint8Array): string {
  const units = Math.floor(bytes.length / 2);
  let out = '';
  const chunk: number[] = [];
  for (let i = 0; i < units; i++) {
    const unit = (bytes[2 * i] ?? 0) | ((bytes[2 * i + 1] ?? 0) << 8);
    if (unit === 0) break;
    chunk.push(unit);
    if (chunk.length === 4096) {
      out += String.fromCharCode(...chunk);
      chunk.length = 0;
    }
  }
  return out + String.fromCharCode(...chunk);
}

// Windows-1252 code points for bytes 0x80–0x9F; the rest of the range maps to itself.
const CP1252_HIGH = [
  0x20ac, 0x81, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039,
  0x0152, 0x8d, 0x017d, 0x8f, 0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
  0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x9d, 0x017e, 0x0178,
];

/**
 * Decodes the "extended ASCII" of TextExtendedAscii ([MS-ONE] 2.2.89) as
 * Windows-1252, stopping at the first NUL.
 */
export function decodeExtendedAscii(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) {
    if (byte === 0) break;
    const code = byte >= 0x80 && byte < 0xa0 ? (CP1252_HIGH[byte - 0x80] ?? byte) : byte;
    out += String.fromCharCode(code);
  }
  return out;
}
