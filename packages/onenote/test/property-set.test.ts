import { describe, expect, it } from 'vitest';
import { FormatError } from '../src/bytes.js';
import { readObjectPropSet, type PropertySet } from '../src/property-set.js';
import { encodePropSet, testGuid, Writer, type TestProp } from './store-builder.js';

// Test ids: the low 26 bits are arbitrary, the type sits in bits 26–30.
const pid = (type: number, id: number) => ((type << 26) | id) >>> 0;
const A = `${testGuid(1)}/1`;
const B = `${testGuid(2)}/0`;
const C = `${testGuid(3)}/4`;
const GUIDS = [testGuid(1), testGuid(2), testGuid(3)];

function roundTrip(props: TestProp[]): PropertySet {
  const compactId = (id: string) => {
    const [g, n] = id.split('/');
    return ((GUIDS.indexOf(g!) << 8) | Number(n)) >>> 0;
  };
  const bytes = Uint8Array.from(encodePropSet(props, compactId));
  const table = new Map(GUIDS.map((g, i) => [i, g]));
  return readObjectPropSet(bytes, 0, bytes.length, (c) => {
    const guid = table.get(c >>> 8);
    return guid ? `${guid}/${c & 0xff}` : null;
  });
}

describe('PropertySet', () => {
  it('reads NoData and both Bool values', () => {
    const set = roundTrip([{ id: pid(0x1, 1), data: [] }, { id: pid(0x2, 2), bool: true }, { id: pid(0x2, 3), bool: false }]);
    expect(set.get(pid(0x1, 1))).toEqual({ kind: 'none' });
    expect(set.bool(pid(0x2, 2))).toBe(true);
    expect(set.bool(pid(0x2, 3))).toBe(false);
  });

  it('reads 1, 2, 4 and 8 byte values and length-prefixed data in order', () => {
    const set = roundTrip([
      { id: pid(0x3, 1), data: [0x7f] },
      { id: pid(0x4, 2), data: [0x34, 0x12] },
      { id: pid(0x5, 3), data: new Writer().f32(1.5).bytes },
      { id: pid(0x6, 4), data: new Writer().u64(0x1_0000_0002).bytes },
      { id: pid(0x7, 5), data: new Writer().utf16('Hi').u16(0).bytes },
    ]);
    expect(set.uint(pid(0x3, 1))).toBe(0x7f);
    expect(set.uint(pid(0x4, 2))).toBe(0x1234);
    expect(set.float(pid(0x5, 3))).toBe(1.5);
    expect(set.uint(pid(0x6, 4))).toBe(0x1_0000_0002);
    expect(set.string(pid(0x7, 5))).toBe('Hi');
  });

  it('matches object, object space and context references to their streams in property order', () => {
    const set = roundTrip([
      { id: pid(0x8, 1), refs: [A] },
      { id: pid(0x9, 2), refs: [B, C] },
      { id: pid(0xa, 3), refs: [C] },
      { id: pid(0xb, 4), refs: [A, B] },
      { id: pid(0xc, 5), refs: [B] },
      { id: pid(0xd, 6), refs: [C, A] },
    ]);
    expect(set.objectId(pid(0x8, 1))).toBe(A);
    expect(set.objectIds(pid(0x9, 2))).toEqual([B, C]);
    expect(set.spaceIds(pid(0xa, 3))).toEqual([C]);
    expect(set.spaceIds(pid(0xb, 4))).toEqual([A, B]);
    expect(set.get(pid(0xc, 5))).toEqual({ kind: 'contexts', value: [B], single: true });
    expect(set.get(pid(0xd, 6))).toEqual({ kind: 'contexts', value: [C, A], single: false });
  });

  it('reads arrays of property values and nested property sets, sharing the reference streams', () => {
    const set = roundTrip([
      { id: pid(0x8, 1), refs: [A] },
      { id: pid(0x10, 2), sets: [[{ id: pid(0x8, 9), refs: [B] }], [{ id: pid(0x3, 8), data: [5] }]] },
      { id: pid(0x11, 3), sets: [[{ id: pid(0x8, 9), refs: [C] }]] },
      { id: pid(0x10, 4), sets: [] },
    ]);
    const [first, second] = set.sets(pid(0x10, 2));
    expect(first!.objectId(pid(0x8, 9))).toBe(B);
    expect(second!.uint(pid(0x3, 8))).toBe(5);
    expect(set.sets(pid(0x11, 3))[0]!.objectId(pid(0x8, 9))).toBe(C);
    expect(set.sets(pid(0x10, 4))).toEqual([]);
  });

  it('keeps unresolved references as null and skips them in the id accessors', () => {
    const bytes = new Writer().u32(0x80000001).u32(0x00ff0001).u16(1).u32(pid(0x8, 1)).toArray();
    const set = readObjectPropSet(bytes, 0, bytes.length, () => null);
    expect(set.get(pid(0x8, 1))).toEqual({ kind: 'objects', value: [null], single: true });
    expect(set.objectIds(pid(0x8, 1))).toEqual([]);
  });

  it('throws a FormatError when data or references run out', () => {
    const shortData = new Writer().u32(0x80000000).u16(1).u32(pid(0x7, 1)).u32(100).toArray();
    expect(() => readObjectPropSet(shortData, 0, shortData.length, () => null)).toThrow(FormatError);
    const noRefs = new Writer().u32(0x80000000).u16(1).u32(pid(0x8, 1)).toArray();
    expect(() => readObjectPropSet(noRefs, 0, noRefs.length, () => null)).toThrow(/references/);
  });

  it('returns undefined from accessors for absent or differently typed properties', () => {
    const set = roundTrip([{ id: pid(0x2, 1), bool: true }]);
    expect(set.uint(pid(0x2, 1))).toBeUndefined();
    expect(set.bool(pid(0x2, 99))).toBeUndefined();
    expect(set.objectIds(pid(0x9, 99))).toEqual([]);
  });
});
