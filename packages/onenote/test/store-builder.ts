// Builds small revision store files ([MS-ONESTORE] 2.3–2.6) byte by byte, so
// tests can exercise the reader without real notebooks. Every list is one
// fragment, every file pointer is uncompressed, and there is one transaction.
import { FileNodeId } from '../src/file-node-ids.js';
import { GUID_FILE_FORMAT_REVISION_STORE, GUID_FILE_TYPE_ONE } from '../src/file-node-list.js';

/** GUID text to its 16 bytes in [MS-DTYP] layout. */
export function guidBytes(guid: string): number[] {
  const hex = guid.replace(/[{}-]/g, '');
  const b = (i: number) => parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return [b(3), b(2), b(1), b(0), b(5), b(4), b(7), b(6), ...Array.from({ length: 8 }, (_, i) => b(8 + i))];
}

/** A test GUID whose last group encodes `n`, e.g. testGuid(5) → 00000000-…-000000000005. */
export function testGuid(n: number): string {
  return `11111111-2222-3333-4444-${n.toString(16).padStart(12, '0')}`;
}

export class Writer {
  readonly bytes: number[] = [];
  get length(): number {
    return this.bytes.length;
  }
  u8(v: number): this {
    this.bytes.push(v & 0xff);
    return this;
  }
  u16(v: number): this {
    return this.u8(v).u8(v >>> 8);
  }
  u32(v: number): this {
    return this.u16(v & 0xffff).u16(v >>> 16);
  }
  u64(v: number): this {
    return this.u32(v % 0x1_0000_0000).u32(Math.floor(v / 0x1_0000_0000));
  }
  f32(v: number): this {
    const b = new Uint8Array(new Float32Array([v]).buffer);
    return this.raw(b);
  }
  raw(b: ArrayLike<number>): this {
    for (let i = 0; i < b.length; i++) this.bytes.push(b[i]!);
    return this;
  }
  guid(g: string): this {
    return this.raw(guidBytes(g));
  }
  exGuid(id: string): this {
    const [g, n] = id.split('/');
    return this.guid(g!).u32(Number(n));
  }
  utf16(s: string): this {
    for (let i = 0; i < s.length; i++) this.u16(s.charCodeAt(i));
    return this;
  }
  toArray(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}

export const utf16z = (s: string): Uint8Array => new Writer().utf16(s).u16(0).toArray();

/** A FileNode header ([MS-ONESTORE] 2.4.3) packed into 32 bits. */
export function fileNodeHeader(id: number, size: number, stpFormat: number, cbFormat: number, baseType: number): number {
  return (id | (size << 10) | (stpFormat << 23) | (cbFormat << 25) | (baseType << 27) | (1 << 31)) >>> 0;
}

export interface TestNode {
  id: number;
  /** For BaseType 1 or 2: where the referenced data sits. */
  ref?: { stp: number; cb: number };
  body?: ArrayLike<number>;
}

/** Encodes one FileNode with an uncompressed 8-byte stp and 4-byte cb when it has a reference. */
export function encodeNode(node: TestNode): number[] {
  const body = new Writer();
  let baseType = 0;
  if (node.ref) {
    baseType = node.id === FileNodeId.ObjectSpaceManifestListReference ||
      node.id === FileNodeId.RevisionManifestListReference ||
      node.id === FileNodeId.ObjectGroupListReference ||
      node.id === FileNodeId.FileDataStoreListReference
      ? 2
      : 1;
    body.u64(node.ref.stp).u32(node.ref.cb);
  }
  if (node.body) body.raw(node.body);
  return new Writer().u32(fileNodeHeader(node.id, 4 + body.length, 0, 0, baseType)).raw(body.bytes).bytes;
}

/** Accumulates a file: a 1024-byte header followed by blocks appended at 8-byte boundaries. */
export class FileBuilder {
  private readonly out = new Writer();
  private nextListId = 0x10;
  readonly listCounts = new Map<number, number>();

  constructor() {
    this.out.raw(new Array(1024).fill(0));
  }

  append(block: ArrayLike<number>): { stp: number; cb: number } {
    while (this.out.length % 8 !== 0) this.out.u8(0);
    const stp = this.out.length;
    this.out.raw(block);
    return { stp, cb: block.length };
  }

  /** Appends a one-fragment file node list ([MS-ONESTORE] 2.4.1) and records its node count. */
  list(nodes: TestNode[], options: { extraBytes?: number[]; listId?: number } = {}): { stp: number; cb: number } {
    const listId = options.listId ?? this.nextListId++;
    const w = new Writer().u32(0xf5f7f4c4).u32(0xa4567ab1).u32(listId).u32(0);
    for (const node of nodes) w.raw(encodeNode(node));
    if (options.extraBytes) w.raw(options.extraBytes);
    w.u32(0); // padding, read as a zero FileNode header
    w.u32(0xffffffff).u32(0xffffffff).u32(0); // nextFragment: fcrNil
    w.u32(0x8233ba4b).u32(0x8bc215c3);
    this.listCounts.set(listId, nodes.length);
    return this.append(w.bytes);
  }

  /** Writes the transaction log and header, and returns the finished file. */
  finish(root: { stp: number; cb: number }): Uint8Array {
    const log = new Writer();
    for (const [listId, count] of this.listCounts) log.u32(listId).u32(count);
    log.u32(1).u32(0);
    log.u32(0xffffffff).u32(0xffffffff).u32(0);
    const logRef = this.append(log.bytes);
    const bytes = this.out.toArray();
    const header = new Writer()
      .guid(GUID_FILE_TYPE_ONE)
      .guid(testGuid(0xf11e))
      .guid('00000000-0000-0000-0000-000000000000')
      .guid(GUID_FILE_FORMAT_REVISION_STORE)
      .u32(0x2a).u32(0x2a).u32(0x2a).u32(0x2a)
      .u32(0).u32(0)
      .u32(0xffffffff).u32(0)
      .u32(1) // cTransactionsInLog
      .u32(0).u64(0)
      .u32(0xffffffff).u32(0)
      .u32(0).u32(0)
      .guid('00000000-0000-0000-0000-000000000000')
      .u32(0)
      .u64(0).u32(0) // fcrHashedChunkList
      .u64(logRef.stp).u32(logRef.cb)
      .u64(root.stp).u32(root.cb);
    bytes.set(header.bytes, 0);
    return bytes;
  }
}

/** A property in a test object. References are ExtendedGUID keys ("guid/n"). */
export type TestProp =
  | { id: number; bool: boolean }
  | { id: number; data: ArrayLike<number> }
  | { id: number; refs: string[] }
  | { id: number; sets: TestProp[][] };

export interface TestObject {
  id: string;
  jcid: number;
  props?: TestProp[];
  /** Raw ObjectSpaceObjectPropSet bytes used instead of `props`, to test damaged objects. */
  raw?: number[];
  file?: { data: Uint8Array; extension: string };
}

export interface TestSpace {
  id: string;
  roots: Array<[role: number, object: string]>;
  objects: TestObject[];
  encrypted?: boolean;
}

/** Encodes an ObjectSpaceObjectPropSet ([MS-ONESTORE] 2.6.1) with `compactId` mapping references. */
export function encodePropSet(props: TestProp[], compactId: (id: string) => number): number[] {
  const oids: number[] = [];
  const osids: number[] = [];
  const contexts: number[] = [];
  const encodeSet = (set: TestProp[], w: Writer) => {
    w.u16(set.length);
    const data = new Writer();
    for (const prop of set) {
      const type = (prop.id >>> 26) & 0x1f;
      let prid = prop.id & 0x7fffffff;
      if ('bool' in prop && prop.bool) prid |= 0x80000000;
      w.u32(prid >>> 0);
      if ('data' in prop) {
        if (type === 0x7) data.u32(prop.data.length);
        data.raw(prop.data);
      } else if ('refs' in prop) {
        const stream = type === 0x8 || type === 0x9 ? oids : type === 0xa || type === 0xb ? osids : contexts;
        if (type === 0x9 || type === 0xb || type === 0xd) data.u32(prop.refs.length);
        for (const ref of prop.refs) stream.push(compactId(ref));
      } else if ('sets' in prop) {
        if (type === 0x10) {
          data.u32(prop.sets.length);
          if (prop.sets.length > 0) data.u32(0x11 << 26);
        }
        for (const nested of prop.sets) encodeSet(nested, data);
      }
    }
    w.raw(data.bytes);
  };
  const body = new Writer();
  encodeSet(props, body);
  const w = new Writer();
  const hasOsids = osids.length > 0 || contexts.length > 0;
  w.u32((oids.length | (hasOsids ? 0 : 0x80000000)) >>> 0);
  for (const id of oids) w.u32(id);
  if (hasOsids) {
    w.u32((osids.length | (contexts.length > 0 ? 0x40000000 : 0)) >>> 0);
    for (const id of osids) w.u32(id);
    if (contexts.length > 0) {
      w.u32(contexts.length);
      for (const id of contexts) w.u32(id);
    }
  }
  return w.raw(body.bytes).bytes;
}

function collectGuids(objects: TestObject[]): string[] {
  const guids = new Set<string>();
  const visit = (props: TestProp[]) => {
    for (const prop of props) {
      if ('refs' in prop) for (const ref of prop.refs) guids.add(ref.split('/')[0]!);
      if ('sets' in prop) for (const set of prop.sets) visit(set);
    }
  };
  for (const object of objects) {
    guids.add(object.id.split('/')[0]!);
    visit(object.props ?? []);
  }
  return [...guids];
}

/** Builds a whole revision store file holding `spaces`, with `rootSpace` as the root object space. */
export function buildRevisionStore(spaces: TestSpace[], rootSpace: string): Uint8Array {
  const file = new FileBuilder();
  const fileDataRefs: TestNode[] = [];
  const rootNodes: TestNode[] = [];
  for (const space of spaces) {
    const guids = collectGuids(space.objects);
    const index = new Map(guids.map((g, i) => [g, i]));
    const compactId = (id: string) => {
      const [g, n] = id.split('/');
      return ((index.get(g!)! << 8) | Number(n)) >>> 0;
    };
    const groupNodes: TestNode[] = [{ id: FileNodeId.ObjectGroupStart, body: new Writer().exGuid(`${testGuid(0x9000)}/1`).bytes }];
    groupNodes.push({ id: FileNodeId.GlobalIdTableStart2 });
    guids.forEach((g, i) => groupNodes.push({ id: FileNodeId.GlobalIdTableEntry, body: new Writer().u32(i).guid(g).bytes }));
    groupNodes.push({ id: FileNodeId.GlobalIdTableEnd });
    for (const object of space.objects) {
      if (object.file) {
        const reference = `${testGuid(0xd000 + fileDataRefs.length)}`;
        const stored = new Writer().guid('bde316e7-2665-4511-a4c4-8d4d0b7a9eac').u64(object.file.data.length).u32(0).u64(0).raw(object.file.data);
        while (stored.length % 8 !== 0) stored.u8(0);
        stored.guid('71fba722-0f79-4a0b-bb13-899256426b24');
        fileDataRefs.push({ id: FileNodeId.FileDataStoreObjectReference, ref: file.append(stored.bytes), body: guidBytes(reference) });
        const ref = `<ifndf>{${reference}}`;
        groupNodes.push({
          id: FileNodeId.ObjectDeclarationFileData3RefCount,
          body: new Writer().u32(compactId(object.id)).u32(object.jcid).u8(1)
            .u32(ref.length).utf16(ref).u32(object.file.extension.length).utf16(object.file.extension).bytes,
        });
        continue;
      }
      const propSet = file.append(object.raw ?? encodePropSet(object.props ?? [], compactId));
      groupNodes.push({
        id: FileNodeId.ObjectDeclaration2RefCount,
        ref: propSet,
        body: new Writer().u32(compactId(object.id)).u32(object.jcid).u8(0).u8(1).bytes,
      });
    }
    groupNodes.push({ id: FileNodeId.ObjectGroupEnd });
    const group = file.list(groupNodes);

    const revisionNodes: TestNode[] = [
      { id: FileNodeId.RevisionManifestListStart, body: new Writer().exGuid(space.id).u32(0).bytes },
      {
        id: FileNodeId.RevisionManifestStart6,
        body: new Writer().exGuid(`${testGuid(0xa000)}/1`).exGuid('00000000-0000-0000-0000-000000000000/0').u32(1).u16(space.encrypted ? 2 : 0).bytes,
      },
      { id: FileNodeId.ObjectGroupListReference, ref: group, body: new Writer().exGuid(`${testGuid(0x9000)}/1`).bytes },
      ...space.roots.map(([role, object]) => ({ id: FileNodeId.RootObjectReference3, body: new Writer().exGuid(object).u32(role).bytes })),
      { id: FileNodeId.RevisionManifestEnd },
    ];
    const revisionList = file.list(revisionNodes);
    const manifestList = file.list([
      { id: FileNodeId.ObjectSpaceManifestListStart, body: new Writer().exGuid(space.id).bytes },
      { id: FileNodeId.RevisionManifestListReference, ref: revisionList },
    ]);
    rootNodes.push({ id: FileNodeId.ObjectSpaceManifestListReference, ref: manifestList, body: new Writer().exGuid(space.id).bytes });
  }
  rootNodes.push({ id: FileNodeId.ObjectSpaceManifestRoot, body: new Writer().exGuid(rootSpace).bytes });
  if (fileDataRefs.length > 0) rootNodes.push({ id: FileNodeId.FileDataStoreListReference, ref: file.list(fileDataRefs) });
  return file.finish(file.list(rootNodes));
}
