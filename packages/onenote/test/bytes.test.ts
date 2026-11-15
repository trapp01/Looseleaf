import { describe, expect, it } from 'vitest';
import { ByteReader, decodeExtendedAscii, decodeUtf16, formatGuid, FormatError, splitCompactId } from '../src/bytes.js';
import { resolveCompactId } from '../src/revision-store.js';
import { guidBytes, Writer } from './store-builder.js';

describe('GUID and ExtendedGUID', () => {
  it('formats the first three GUID fields little-endian', () => {
    const bytes = Uint8Array.from([
      0xe4, 0x52, 0x5c, 0x7b, 0x8c, 0xd8, 0xa7, 0x4d, 0xae, 0xb1, 0x53, 0x78, 0xd0, 0x29, 0x96, 0xd3,
    ]);
    expect(formatGuid(bytes)).toBe('7b5c52e4-d88c-4da7-aeb1-5378d02996d3');
    expect(Array.from(guidBytes('7b5c52e4-d88c-4da7-aeb1-5378d02996d3'))).toEqual(Array.from(bytes));
  });

  it('reads an ExtendedGUID as guid/n', () => {
    const bytes = new Writer().guid('cfdc64ca-6425-4223-903f-0b7d8a6690f9').u32(1).toArray();
    expect(new ByteReader(bytes).extendedGuid()).toBe('cfdc64ca-6425-4223-903f-0b7d8a6690f9/1');
  });
});

describe('CompactID', () => {
  it('splits n (low 8 bits) from guidIndex (high 24 bits)', () => {
    expect(splitCompactId(0x00000305)).toEqual({ n: 5, guidIndex: 3 });
    expect(splitCompactId(0xffffff01)).toEqual({ n: 1, guidIndex: 0xffffff });
  });

  it('resolves through the global id table and yields null for unknown indexes', () => {
    const table = new Map([[2, 'aaaaaaaa-0000-0000-0000-000000000000']]);
    expect(resolveCompactId(table, 0x0207)).toBe('aaaaaaaa-0000-0000-0000-000000000000/7');
    expect(resolveCompactId(table, 0x0307)).toBeNull();
  });
});

describe('file chunk references', () => {
  it('reads FileChunkReference32 and its nil value', () => {
    expect(new ByteReader(new Writer().u32(0x400).u32(0x20).toArray()).chunkRef32()).toEqual({ stp: 0x400, cb: 0x20 });
    expect(new ByteReader(new Writer().u32(0xffffffff).u32(0).toArray()).chunkRef32()).toBeNull();
  });

  it('reads FileChunkReference64x32 with a stp above 32 bits, and fcrNil', () => {
    const r = new ByteReader(new Writer().u32(0x10).u32(0x1).u32(0x30).u32(0xffffffff).u32(0xffffffff).u32(0).toArray());
    expect(r.chunkRef64x32()).toEqual({ stp: 0x1_0000_0010, cb: 0x30 });
    expect(r.chunkRef64x32()).toBeNull();
  });

  it('reads every FileNodeChunkReference stp and cb format', () => {
    // StpFormat 0 (8 bytes) with CbFormat 1 (8 bytes).
    expect(new ByteReader(new Writer().u64(0x1234).u64(0x56).toArray()).fileNodeChunkRef(0, 1)).toEqual({ stp: 0x1234, cb: 0x56 });
    // StpFormat 1 (4 bytes) with CbFormat 0 (4 bytes).
    expect(new ByteReader(new Writer().u32(0x1234).u32(0x56).toArray()).fileNodeChunkRef(1, 0)).toEqual({ stp: 0x1234, cb: 0x56 });
    // StpFormat 2 (2 bytes ×8) with CbFormat 2 (1 byte ×8), as in the spec's example.
    expect(new ByteReader(new Writer().u16(0x0180).u8(0x24).toArray()).fileNodeChunkRef(2, 2)).toEqual({ stp: 0xc00, cb: 0x120 });
    // StpFormat 3 (4 bytes ×8) with CbFormat 3 (2 bytes ×8).
    expect(new ByteReader(new Writer().u32(0x10).u16(0x3).toArray()).fileNodeChunkRef(3, 3)).toEqual({ stp: 0x80, cb: 0x18 });
  });

  it('treats an all-ones stp as fcrNil in every width', () => {
    expect(new ByteReader(new Writer().u16(0xffff).u8(0).toArray()).fileNodeChunkRef(2, 2)).toBeNull();
    expect(new ByteReader(new Writer().u32(0xffffffff).u32(0).toArray()).fileNodeChunkRef(1, 0)).toBeNull();
    expect(new ByteReader(new Writer().u32(0xffffffff).u32(0xffffffff).u32(0).toArray()).fileNodeChunkRef(0, 0)).toBeNull();
  });
});

describe('ByteReader bounds', () => {
  it('throws a FormatError with the offset when reading past the end', () => {
    const r = new ByteReader(Uint8Array.from([1, 2, 3]));
    r.u16();
    expect(() => r.u32()).toThrow(FormatError);
    try {
      r.u32();
    } catch (e) {
      expect((e as FormatError).offset).toBe(2);
    }
  });

  it('refuses a range outside the buffer', () => {
    expect(() => new ByteReader(new Uint8Array(4), 2, 10)).toThrow(FormatError);
  });

  it('takes views without copying', () => {
    const bytes = Uint8Array.from([1, 2, 3, 4]);
    const view = new ByteReader(bytes, 1).take(2);
    expect(view.buffer).toBe(bytes.buffer);
    expect(Array.from(view)).toEqual([2, 3]);
  });
});

describe('text decoding', () => {
  it('decodes UTF-16LE up to the first NUL, including surrogate pairs', () => {
    const bytes = new Writer().utf16('Hi é😀').u16(0).utf16('ignored').toArray();
    expect(decodeUtf16(bytes)).toBe('Hi é😀');
  });

  it('decodes extended ASCII as Windows-1252', () => {
    expect(decodeExtendedAscii(Uint8Array.from([0x93, 0x41, 0x94, 0xa0, 0xe9, 0x80]))).toBe('“A” é€');
  });
});
