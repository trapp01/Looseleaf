/**
 * ObjectSpaceObjectPropSet and PropertySet ([MS-ONESTORE] 2.6.1–2.6.9): one
 * object's properties with every object, object space and context reference
 * already resolved to an ExtendedGUID. Property meanings live in
 * property-ids.ts; this module knows only the encoding.
 */
import { ByteReader, decodeUtf16, FormatError, type ExGuid } from './bytes.js';

/** PropertyID.type values ([MS-ONESTORE] 2.6.6). */
export const PropertyType = {
  NoData: 0x1,
  Bool: 0x2,
  OneByteOfData: 0x3,
  TwoBytesOfData: 0x4,
  FourBytesOfData: 0x5,
  EightBytesOfData: 0x6,
  FourBytesOfLengthFollowedByData: 0x7,
  ObjectID: 0x8,
  ArrayOfObjectIDs: 0x9,
  ObjectSpaceID: 0xa,
  ArrayOfObjectSpaceIDs: 0xb,
  ContextID: 0xc,
  ArrayOfContextIDs: 0xd,
  ArrayOfPropertyValues: 0x10,
  PropertySet: 0x11,
} as const;

/** One property's value. Reference ids are null when the CompactID does not resolve. */
export type PropertyValue =
  | { kind: 'none' }
  | { kind: 'bool'; value: boolean }
  | { kind: 'bytes'; value: Uint8Array }
  | { kind: 'objects'; value: Array<ExGuid | null>; single: boolean }
  | { kind: 'spaces'; value: Array<ExGuid | null>; single: boolean }
  | { kind: 'contexts'; value: Array<ExGuid | null>; single: boolean }
  | { kind: 'sets'; value: PropertySet[] };

/** Maps a CompactID's 32-bit value to the ExtendedGUID it names, or null. */
export type CompactIdResolver = (compactId: number) => ExGuid | null;

// Nested PropertySet values are rare and shallow; a deeper chain means corrupt data.
const MAX_NESTING = 32;

/**
 * Properties keyed by PropertyID.id (the low 26 bits). Accessors take the full
 * PropertyID constants from property-ids.ts and return undefined when the
 * property is absent or stored with an unexpected type.
 */
export class PropertySet {
  static readonly EMPTY = new PropertySet(new Map());

  constructor(readonly values: ReadonlyMap<number, PropertyValue>) {}

  get(propertyId: number): PropertyValue | undefined {
    return this.values.get(propertyId & 0x3ffffff);
  }

  has(propertyId: number): boolean {
    return this.values.has(propertyId & 0x3ffffff);
  }

  bool(propertyId: number): boolean | undefined {
    const v = this.get(propertyId);
    return v?.kind === 'bool' ? v.value : undefined;
  }

  bytes(propertyId: number): Uint8Array | undefined {
    const v = this.get(propertyId);
    return v?.kind === 'bytes' ? v.value : undefined;
  }

  /** An unsigned integer from a 1, 2, 4 or 8 byte property. */
  uint(propertyId: number): number | undefined {
    const b = this.bytes(propertyId);
    if (!b || b.length === 0 || b.length > 8) return undefined;
    let value = 0;
    for (let i = b.length - 1; i >= 0; i--) value = value * 256 + (b[i] ?? 0);
    return value;
  }

  int32(propertyId: number): number | undefined {
    const value = this.uint(propertyId);
    return value === undefined ? undefined : value | 0;
  }

  float(propertyId: number): number | undefined {
    const b = this.bytes(propertyId);
    if (!b || b.length !== 4) return undefined;
    const value = new DataView(b.buffer, b.byteOffset, 4).getFloat32(0, true);
    return Number.isFinite(value) ? value : undefined;
  }

  /** A WzInAtom-style UTF-16LE string ([MS-ONE] 2.2.9). */
  string(propertyId: number): string | undefined {
    const b = this.bytes(propertyId);
    return b ? decodeUtf16(b) : undefined;
  }

  /** An ArrayOfUINT32s ([MS-ONE] 2.2.11) stored as length-prefixed data. */
  uint32s(propertyId: number): number[] | undefined {
    const b = this.bytes(propertyId);
    if (!b) return undefined;
    const r = new ByteReader(b);
    const out: number[] = [];
    while (r.remaining >= 4) out.push(r.u32());
    return out;
  }

  objectId(propertyId: number): ExGuid | undefined {
    const v = this.get(propertyId);
    return v?.kind === 'objects' ? (v.value[0] ?? undefined) : undefined;
  }

  /** Object references in order, without unresolved entries. */
  objectIds(propertyId: number): ExGuid[] {
    const v = this.get(propertyId);
    return v?.kind === 'objects' ? v.value.filter((id): id is ExGuid => id !== null) : [];
  }

  spaceIds(propertyId: number): ExGuid[] {
    const v = this.get(propertyId);
    return v?.kind === 'spaces' ? v.value.filter((id): id is ExGuid => id !== null) : [];
  }

  sets(propertyId: number): PropertySet[] {
    const v = this.get(propertyId);
    return v?.kind === 'sets' ? v.value : [];
  }
}

interface IdStream {
  ids: number[];
  next: number;
}

/**
 * Reads an ObjectSpaceObjectPropSet ([MS-ONESTORE] 2.6.1) from `bytes[start, end)`.
 * Throws FormatError when the structure is malformed.
 */
export function readObjectPropSet(
  bytes: Uint8Array,
  start: number,
  end: number,
  resolve: CompactIdResolver,
): PropertySet {
  const r = new ByteReader(bytes, start, end);
  const oids = readIdStream(r);
  let osids: IdStream = { ids: [], next: 0 };
  let contexts: IdStream = { ids: [], next: 0 };
  if (!oids.osidStreamNotPresent) {
    const osidStream = readIdStream(r);
    osids = osidStream;
    if (osidStream.extendedStreamsPresent) contexts = readIdStream(r);
  }
  return readPropertySet(r, { oids, osids, contexts, resolve }, 0);
}

interface StreamHeaderResult extends IdStream {
  osidStreamNotPresent: boolean;
  extendedStreamsPresent: boolean;
}

/** An ObjectSpaceObjectStreamHeader ([MS-ONESTORE] 2.6.5) and its CompactIDs. */
function readIdStream(r: ByteReader): StreamHeaderResult {
  const header = r.u32();
  const count = header & 0xffffff;
  if (count * 4 > r.remaining) throw new FormatError(`Reference stream claims ${count} ids`, r.pos - 4);
  const ids: number[] = new Array(count);
  for (let i = 0; i < count; i++) ids[i] = r.u32();
  return {
    ids,
    next: 0,
    extendedStreamsPresent: (header & 0x40000000) !== 0,
    osidStreamNotPresent: (header & 0x80000000) !== 0,
  };
}

interface Streams {
  oids: IdStream;
  osids: IdStream;
  contexts: IdStream;
  resolve: CompactIdResolver;
}

function takeIds(stream: IdStream, count: number, resolve: CompactIdResolver, at: number): Array<ExGuid | null> {
  if (stream.next + count > stream.ids.length) {
    throw new FormatError(`Property needs ${count} references but the stream has ${stream.ids.length - stream.next} left`, at);
  }
  const out: Array<ExGuid | null> = new Array(count);
  for (let i = 0; i < count; i++) out[i] = resolve(stream.ids[stream.next + i] ?? 0);
  stream.next += count;
  return out;
}

/** A PropertySet ([MS-ONESTORE] 2.6.7). Reference streams are shared with nested sets, in order. */
function readPropertySet(r: ByteReader, streams: Streams, depth: number): PropertySet {
  if (depth > MAX_NESTING) throw new FormatError('Property sets nest too deeply', r.pos);
  const count = r.u16();
  if (count * 4 > r.remaining) throw new FormatError(`Property set claims ${count} properties`, r.pos - 2);
  const prids: number[] = new Array(count);
  for (let i = 0; i < count; i++) prids[i] = r.u32();
  const values = new Map<number, PropertyValue>();
  for (const prid of prids) {
    const id = prid & 0x3ffffff;
    const type = (prid >>> 26) & 0x1f;
    values.set(id, readValue(r, type, prid, streams, depth));
  }
  return new PropertySet(values);
}

function readValue(r: ByteReader, type: number, prid: number, streams: Streams, depth: number): PropertyValue {
  const at = r.pos;
  switch (type) {
    case PropertyType.NoData:
      return { kind: 'none' };
    case PropertyType.Bool:
      return { kind: 'bool', value: (prid & 0x80000000) !== 0 };
    case PropertyType.OneByteOfData:
      return { kind: 'bytes', value: r.take(1) };
    case PropertyType.TwoBytesOfData:
      return { kind: 'bytes', value: r.take(2) };
    case PropertyType.FourBytesOfData:
      return { kind: 'bytes', value: r.take(4) };
    case PropertyType.EightBytesOfData:
      return { kind: 'bytes', value: r.take(8) };
    case PropertyType.FourBytesOfLengthFollowedByData: {
      const cb = r.u32();
      if (cb >= 0x40000000) throw new FormatError(`Property data length ${cb} is out of range`, at);
      return { kind: 'bytes', value: r.take(cb) };
    }
    case PropertyType.ObjectID:
      return { kind: 'objects', value: takeIds(streams.oids, 1, streams.resolve, at), single: true };
    case PropertyType.ArrayOfObjectIDs:
      return { kind: 'objects', value: takeIds(streams.oids, r.u32(), streams.resolve, at), single: false };
    case PropertyType.ObjectSpaceID:
      return { kind: 'spaces', value: takeIds(streams.osids, 1, streams.resolve, at), single: true };
    case PropertyType.ArrayOfObjectSpaceIDs:
      return { kind: 'spaces', value: takeIds(streams.osids, r.u32(), streams.resolve, at), single: false };
    case PropertyType.ContextID:
      return { kind: 'contexts', value: takeIds(streams.contexts, 1, streams.resolve, at), single: true };
    case PropertyType.ArrayOfContextIDs:
      return { kind: 'contexts', value: takeIds(streams.contexts, r.u32(), streams.resolve, at), single: false };
    case PropertyType.ArrayOfPropertyValues: {
      // prtArrayOfPropertyValues ([MS-ONESTORE] 2.6.9): every element is a PropertySet.
      const count = r.u32();
      if (count === 0) return { kind: 'sets', value: [] };
      const elementPrid = r.u32();
      const elementType = (elementPrid >>> 26) & 0x1f;
      if (elementType !== PropertyType.PropertySet) {
        throw new FormatError(`Array of property values holds type 0x${elementType.toString(16)}`, at);
      }
      if (count > r.remaining / 2) throw new FormatError(`Array of property values claims ${count} sets`, at);
      const sets: PropertySet[] = [];
      for (let i = 0; i < count; i++) sets.push(readPropertySet(r, streams, depth + 1));
      return { kind: 'sets', value: sets };
    }
    case PropertyType.PropertySet:
      return { kind: 'sets', value: [readPropertySet(r, streams, depth + 1)] };
    default:
      throw new FormatError(`Unknown property type 0x${type.toString(16)} in property 0x${(prid >>> 0).toString(16)}`, at);
  }
}
