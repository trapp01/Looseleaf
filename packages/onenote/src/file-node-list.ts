/**
 * The physical layer of a revision store file ([MS-ONESTORE] 2.3–2.4): the
 * header, the transaction log, and file node lists split across fragments.
 * Callers get each list as a flat array of FileNodes, cut off at the node
 * count the last committed transaction recorded for it.
 */
import { ByteReader, FormatError, formatGuid, type ChunkRef } from './bytes.js';
import { FileNodeId } from './file-node-ids.js';

export const GUID_FILE_TYPE_ONE = '7b5c52e4-d88c-4da7-aeb1-5378d02996d3';
export const GUID_FILE_TYPE_ONETOC2 = '43ff2fa1-efd9-4c76-9ee2-10ea5722765f';
export const GUID_FILE_FORMAT_REVISION_STORE = '109add3f-911b-49f5-a5d0-1791edc8aed8';
export const GUID_FILE_FORMAT_PACKAGE = '638de92f-a6d4-4bc1-9a36-b3fc2511a5b7';

const HEADER_SIZE = 1024;
const LIST_HEADER_MAGIC_LO = 0xf5f7f4c4;
const LIST_HEADER_MAGIC_HI = 0xa4567ab1;
const LIST_FOOTER_MAGIC_LO = 0x8233ba4b;
const LIST_FOOTER_MAGIC_HI = 0x8bc215c3;

/** The [MS-ONESTORE] 2.3.1 Header fields this reader uses. */
export interface FileHeader {
  fileType: 'section' | 'toc';
  guidFile: string;
  transactionsInLog: number;
  transactionLog: ChunkRef;
  rootFileNodeList: ChunkRef;
}

/** Reads the header's identifying GUIDs; null when the file is shorter than a header. */
export function readHeaderGuids(bytes: Uint8Array): { fileType: string; fileFormat: string } | null {
  if (bytes.length < 64) return null;
  return { fileType: formatGuid(bytes.subarray(0, 16)), fileFormat: formatGuid(bytes.subarray(48, 64)) };
}

/** Reads the header of a file already identified as a revision store. Throws FormatError. */
export function readHeader(bytes: Uint8Array): FileHeader {
  if (bytes.length < HEADER_SIZE) throw new FormatError('File is shorter than the 1024-byte header', 0);
  const r = new ByteReader(bytes, 0, HEADER_SIZE);
  const fileType = r.guid() === GUID_FILE_TYPE_ONETOC2 ? 'toc' : 'section';
  const guidFile = r.guid();
  r.pos = 96;
  const transactionsInLog = r.u32();
  r.pos = 160;
  const transactionLog = r.chunkRef64x32();
  const rootFileNodeList = r.chunkRef64x32();
  if (!transactionLog) throw new FormatError('Header has no transaction log', 160);
  if (!rootFileNodeList || rootFileNodeList.cb === 0) throw new FormatError('Header has no root file node list', 172);
  return { fileType, guidFile, transactionsInLog, transactionLog, rootFileNodeList };
}

/**
 * Reads the transaction log ([MS-ONESTORE] 2.3.3) and returns, per
 * FileNodeListID, the node count after the last committed transaction.
 * Entries past `transactionsInLog` sentinels belong to uncommitted writes.
 */
export function readCommittedNodeCounts(bytes: Uint8Array, header: FileHeader): Map<number, number> {
  const counts = new Map<number, number>();
  let remaining = header.transactionsInLog;
  let ref: ChunkRef | null = header.transactionLog;
  const seen = new Set<number>();
  while (ref && remaining > 0) {
    if (seen.has(ref.stp)) throw new FormatError('Transaction log fragments form a loop', ref.stp);
    seen.add(ref.stp);
    const r: ByteReader = new ByteReader(bytes, ref.stp, ref.stp + ref.cb);
    const entries = Math.floor((ref.cb - 12) / 8);
    for (let i = 0; i < entries && remaining > 0; i++) {
      const srcId = r.u32();
      const value = r.u32();
      if (srcId === 1) remaining--;
      else counts.set(srcId, value);
    }
    if (remaining === 0) break;
    // nextFragment follows the last whole entry; a fragment can end with padding after it.
    r.pos = ref.stp + entries * 8;
    ref = r.chunkRef64x32();
  }
  return counts;
}

/** One FileNode ([MS-ONESTORE] 2.4.3). `ref` is set when BaseType is 1 or 2 and not fcrNil. */
export interface FileNode {
  id: number;
  /** File offset of the node's header, for error messages. */
  offset: number;
  baseType: number;
  ref: ChunkRef | null;
  /** The fnd bytes that follow the reference. */
  body: Uint8Array;
  /** File offset of `body[0]`. */
  bodyOffset: number;
}

export interface FileNodeListReader {
  readonly bytes: Uint8Array;
  /** Every node of the list starting at `first`, in order. Throws FormatError. */
  read(first: ChunkRef): FileNode[];
}

/** Creates a list reader that honours the committed node counts from the transaction log. */
export function fileNodeListReader(bytes: Uint8Array, committed: Map<number, number>): FileNodeListReader {
  return { bytes, read: (first) => readFileNodeList(bytes, first, committed) };
}

function readFileNodeList(bytes: Uint8Array, first: ChunkRef, committed: Map<number, number>): FileNode[] {
  const nodes: FileNode[] = [];
  const seen = new Set<number>();
  let listId: number | undefined;
  let limit: number | undefined;
  let ref: ChunkRef | null = first;
  let expectedSequence = 0;
  while (ref) {
    if (seen.has(ref.stp)) throw new FormatError('File node list fragments form a loop', ref.stp);
    seen.add(ref.stp);
    if (ref.cb < 36) throw new FormatError(`File node list fragment of ${ref.cb} bytes is too small`, ref.stp);
    const r: ByteReader = new ByteReader(bytes, ref.stp, ref.stp + ref.cb);
    if (r.u32() !== LIST_HEADER_MAGIC_LO || r.u32() !== LIST_HEADER_MAGIC_HI) {
      throw new FormatError('File node list fragment has a bad header magic', ref.stp);
    }
    const id = r.u32();
    const sequence = r.u32();
    if (listId === undefined) {
      listId = id;
      limit = committed.get(id);
    } else if (id !== listId) {
      throw new FormatError(`Fragment of list ${id} continues list ${listId}`, ref.stp);
    }
    if (sequence !== expectedSequence) {
      throw new FormatError(`Fragment ${sequence} of list ${id} arrived as fragment ${expectedSequence}`, ref.stp);
    }
    expectedSequence++;
    const nodesEnd = ref.stp + ref.cb - 20;
    while (nodesEnd - r.pos >= 4) {
      if (limit !== undefined && nodes.length >= limit) return nodes;
      const offset = r.pos;
      const header = r.u32();
      const nodeId = header & 0x3ff;
      const size = (header >>> 10) & 0x1fff;
      if (nodeId === FileNodeId.ChunkTerminator || header === 0) break;
      if (size < 4 || offset + size > nodesEnd) {
        throw new FormatError(`FileNode 0x${nodeId.toString(16)} has size ${size}`, offset);
      }
      const baseType = (header >>> 27) & 0xf;
      let nodeRef: ChunkRef | null = null;
      if (baseType === 1 || baseType === 2) {
        const nr = new ByteReader(bytes, r.pos, offset + size);
        nodeRef = nr.fileNodeChunkRef((header >>> 23) & 3, (header >>> 25) & 3);
        r.pos = nr.pos;
        if (nodeRef && nodeRef.stp + nodeRef.cb > bytes.length) {
          throw new FormatError(`FileNode 0x${nodeId.toString(16)} points past the end of the file`, offset);
        }
      }
      nodes.push({
        id: nodeId,
        offset,
        baseType,
        ref: nodeRef,
        body: bytes.subarray(r.pos, offset + size),
        bodyOffset: r.pos,
      });
      r.pos = offset + size;
    }
    if (limit !== undefined && nodes.length >= limit) return nodes;
    r.pos = nodesEnd;
    ref = r.chunkRef64x32();
    if (r.u32() !== LIST_FOOTER_MAGIC_LO || r.u32() !== LIST_FOOTER_MAGIC_HI) {
      throw new FormatError('File node list fragment has a bad footer magic', nodesEnd + 12);
    }
  }
  return nodes;
}
