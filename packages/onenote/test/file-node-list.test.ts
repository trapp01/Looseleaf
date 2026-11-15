import { describe, expect, it } from 'vitest';
import { FormatError } from '../src/bytes.js';
import { FileNodeId } from '../src/file-node-ids.js';
import { fileNodeListReader, readCommittedNodeCounts, readHeader } from '../src/file-node-list.js';
import { encodeNode, FileBuilder, fileNodeHeader, Writer } from './store-builder.js';

describe('FileNode header', () => {
  it('packs FileNodeID, Size, StpFormat, CbFormat, BaseType and the reserved bit as the spec example does', () => {
    // [MS-ONESTORE] 3.2: an ObjectSpaceManifestListReferenceFND of 27 bytes, formats 2/2, base type 2.
    const header = fileNodeHeader(0x008, 27, 2, 2, 2);
    expect(header & 0x3ff).toBe(0x008);
    expect((header >>> 10) & 0x1fff).toBe(27);
    expect((header >>> 23) & 3).toBe(2);
    expect((header >>> 25) & 3).toBe(2);
    expect((header >>> 27) & 0xf).toBe(2);
    expect(header >>> 31).toBe(1);
  });
});

function fragment(listId: number, sequence: number, nodes: number[][], next: { stp: number; cb: number } | null, size?: number): number[] {
  const w = new Writer().u32(0xf5f7f4c4).u32(0xa4567ab1).u32(listId).u32(sequence);
  for (const node of nodes) w.raw(node);
  if (next) w.u32(fileNodeHeader(FileNodeId.ChunkTerminator, 4, 0, 0, 0));
  while (size !== undefined && w.length < size - 20) w.u8(0);
  if (next) w.u64(next.stp).u32(next.cb);
  else w.u32(0xffffffff).u32(0xffffffff).u32(0);
  return w.u32(0x8233ba4b).u32(0x8bc215c3).bytes;
}

const node = (id: number, body: number[] = []) => encodeNode({ id, body });

describe('file node lists', () => {
  it('reads nodes across fragments joined by a ChunkTerminator', () => {
    const file = new FileBuilder();
    const second = fragment(0x20, 1, [node(FileNodeId.RevisionManifestEnd)], null);
    const secondAt = 1024 + 128;
    const first = fragment(0x20, 0, [node(FileNodeId.GlobalIdTableStart2), node(FileNodeId.GlobalIdTableEnd)], { stp: secondAt, cb: second.length }, 128);
    const firstRef = file.append(first);
    expect(file.append(second).stp).toBe(secondAt);
    const bytes = file.finish(firstRef);
    const nodes = fileNodeListReader(bytes, new Map()).read(firstRef);
    expect(nodes.map((n) => n.id)).toEqual([FileNodeId.GlobalIdTableStart2, FileNodeId.GlobalIdTableEnd, FileNodeId.RevisionManifestEnd]);
  });

  it('stops at the committed node count and ignores nodes added by uncommitted transactions', () => {
    const file = new FileBuilder();
    const ref = file.list([{ id: FileNodeId.GlobalIdTableStart2 }], { extraBytes: node(FileNodeId.GlobalIdTableEnd) });
    const bytes = file.finish(ref);
    expect(fileNodeListReader(bytes, new Map([[0x10, 1]])).read(ref)).toHaveLength(1);
    expect(fileNodeListReader(bytes, new Map()).read(ref)).toHaveLength(2);
  });

  it('parses the reference of BaseType 1 and 2 nodes and exposes the rest of the body', () => {
    const file = new FileBuilder();
    const target = file.append(new Array(16).fill(7));
    const ref = file.list([{ id: FileNodeId.FileDataStoreObjectReference, ref: target, body: [1, 2, 3] }]);
    const [n] = fileNodeListReader(file.finish(ref), new Map()).read(ref);
    expect(n!.ref).toEqual(target);
    expect(n!.baseType).toBe(1);
    expect(Array.from(n!.body)).toEqual([1, 2, 3]);
  });

  it('rejects a bad magic, a node larger than its fragment, and a fragment loop', () => {
    const file = new FileBuilder();
    const bad = file.append(new Writer().u32(1).u32(2).u32(0x10).u32(0).raw(new Array(24).fill(0)).bytes);
    const oversized = file.append(fragment(0x11, 0, [new Writer().u32(fileNodeHeader(0x24, 400, 0, 0, 0)).bytes], null));
    const loopAt = oversized.stp + Math.ceil(oversized.cb / 8) * 8;
    const loop = file.append(fragment(0x12, 0, [], { stp: loopAt, cb: 40 }));
    expect(loop.stp).toBe(loopAt);
    const bytes = file.finish(bad);
    const reader = fileNodeListReader(bytes, new Map());
    expect(() => reader.read(bad)).toThrow(/header magic/);
    expect(() => reader.read(oversized)).toThrow(FormatError);
    expect(() => reader.read({ stp: loop.stp, cb: loop.cb })).toThrow(FormatError);
  });
});

describe('header and transaction log', () => {
  it('reads the root list and transaction log references from the header', () => {
    const file = new FileBuilder();
    const root = file.list([{ id: FileNodeId.ObjectSpaceManifestRoot, body: new Array(20).fill(0) }]);
    const bytes = file.finish(root);
    const header = readHeader(bytes);
    expect(header.fileType).toBe('section');
    expect(header.rootFileNodeList).toEqual(root);
    expect(header.transactionsInLog).toBe(1);
  });

  it('keeps the counts of committed transactions only', () => {
    const file = new FileBuilder();
    // Transaction 1 sets list 0x10 to 3 nodes; transaction 2 (uncommitted) would set it to 5.
    const log = new Writer().u32(0x10).u32(3).u32(1).u32(0).u32(0x10).u32(5).u32(1).u32(0).u32(0xffffffff).u32(0xffffffff).u32(0);
    const logRef = file.append(log.bytes);
    const bytes = file.finish({ stp: 0, cb: 0 });
    const counts = readCommittedNodeCounts(bytes, {
      fileType: 'section',
      guidFile: '',
      transactionsInLog: 1,
      transactionLog: logRef,
      rootFileNodeList: { stp: 0, cb: 1 },
    });
    expect(counts.get(0x10)).toBe(3);
  });

  it('finds the next log fragment right after the last whole entry', () => {
    const file = new FileBuilder();
    const second = new Writer().u32(0x11).u32(2).u32(1).u32(0).u32(0xffffffff).u32(0xffffffff).u32(0);
    const secondAt = 1024 + 24;
    // One entry, then nextFragment, then 4 bytes of padding.
    const first = new Writer().u32(0x10).u32(1).u64(secondAt).u32(second.length).u32(0);
    const firstRef = file.append(first.bytes);
    expect(file.append(second.bytes).stp).toBe(secondAt);
    const bytes = file.finish({ stp: 0, cb: 0 });
    const counts = readCommittedNodeCounts(bytes, {
      fileType: 'section',
      guidFile: '',
      transactionsInLog: 1,
      transactionLog: firstRef,
      rootFileNodeList: { stp: 0, cb: 1 },
    });
    expect([...counts]).toEqual([
      [0x10, 1],
      [0x11, 2],
    ]);
  });
});
