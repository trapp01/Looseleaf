/**
 * The logical layer of a revision store file ([MS-ONESTORE] 2.1, 2.5, 2.6):
 * bytes in, object spaces out. Each object space is resolved to its current
 * revision (default context, revision role 1) with objects inherited through
 * the dependency chain, and each object comes with its property set already
 * parsed and its references resolved to ExtendedGUIDs. Knows nothing of pages
 * or outlines; that is the job of the [MS-ONE] layer.
 */
import { ByteReader, decodeUtf16, exGuid, FormatError, NIL_EXGUID, type ChunkRef, type ExGuid } from './bytes.js';
import { FileNodeId } from './file-node-ids.js';
import {
  fileNodeListReader,
  readCommittedNodeCounts,
  readHeader,
  type FileNode,
  type FileNodeListReader,
} from './file-node-list.js';
import { PropertySet, readObjectPropSet } from './property-set.js';

/** RootRole values ([MS-ONE] 2.1.8). */
export const RootRole = { DefaultContent: 1, Metadata: 2, VersionMetadata: 4 } as const;

/** The bytes behind a file data object ([MS-ONESTORE] 2.5.27). */
export type FileData =
  | { kind: 'stored'; data: Uint8Array; extension: string }
  | { kind: 'external'; extension: string }
  | { kind: 'missing'; extension: string };

export interface StoreObject {
  id: ExGuid;
  /** The JCID ([MS-ONESTORE] 2.6.14) as one 32-bit value, as [MS-ONE] tables list it. */
  jcid: number;
  /** Empty for file data objects and for objects whose property set could not be read. */
  props: PropertySet;
  /** Set for file data objects. */
  file?: FileData;
  /** Why the property set could not be read, when it could not. */
  damage?: string;
}

export interface ObjectSpace {
  id: ExGuid;
  /** The current revision's data is encrypted ([MS-ONESTORE] 2.5.19). */
  encrypted: boolean;
  root(role: number): StoreObject | undefined;
  object(id: ExGuid): StoreObject | undefined;
  objectIds(): IterableIterator<ExGuid>;
}

export interface RevisionStore {
  fileType: 'section' | 'toc';
  rootSpaceId: ExGuid;
  /** The object space with this id, read on first use; undefined if absent or unreadable. */
  space(id: ExGuid): ObjectSpace | undefined;
  spaceIds(): ExGuid[];
  /** FileNodeIDs met in lists where this reader does not expect them, with counts. */
  readonly skippedNodes: Map<number, number>;
  /** Object spaces that failed to load, with the reason. */
  readonly damagedSpaces: Map<ExGuid, string>;
}

/** Opens a revision store. Throws FormatError when the header or root file node list is unreadable. */
export function openRevisionStore(bytes: Uint8Array): RevisionStore {
  const header = readHeader(bytes);
  let committed: Map<number, number>;
  try {
    committed = readCommittedNodeCounts(bytes, header);
  } catch {
    // Without the log every node present in the lists is read, which is right for a cleanly closed file.
    committed = new Map();
  }
  const lists = fileNodeListReader(bytes, committed);
  const skippedNodes = new Map<number, number>();
  const skip = (node: FileNode) => skippedNodes.set(node.id, (skippedNodes.get(node.id) ?? 0) + 1);

  const spaceRefs = new Map<ExGuid, ChunkRef>();
  let rootSpaceId: ExGuid | undefined;
  const fileDataStore = new Map<string, ChunkRef>();
  for (const node of lists.read(header.rootFileNodeList)) {
    const r = new ByteReader(node.body);
    switch (node.id) {
      case FileNodeId.ObjectSpaceManifestListReference:
        if (node.ref) spaceRefs.set(r.extendedGuid(), node.ref);
        break;
      case FileNodeId.ObjectSpaceManifestRoot:
        rootSpaceId = r.extendedGuid();
        break;
      case FileNodeId.FileDataStoreListReference:
        if (node.ref) readFileDataStoreList(lists, node.ref, fileDataStore, skip);
        break;
      default:
        skip(node);
    }
  }
  if (!rootSpaceId || !spaceRefs.has(rootSpaceId)) {
    throw new FormatError('Root file node list names no root object space', header.rootFileNodeList.stp);
  }

  const spaces = new Map<ExGuid, ObjectSpace | undefined>();
  const damagedSpaces = new Map<ExGuid, string>();
  return {
    fileType: header.fileType,
    rootSpaceId,
    skippedNodes,
    damagedSpaces,
    spaceIds: () => [...spaceRefs.keys()],
    space(id) {
      if (spaces.has(id)) return spaces.get(id);
      const ref = spaceRefs.get(id);
      let space: ObjectSpace | undefined;
      if (ref) {
        try {
          space = loadObjectSpace(lists, id, ref, fileDataStore, skip);
        } catch (e) {
          damagedSpaces.set(id, e instanceof Error ? e.message : String(e));
        }
      }
      spaces.set(id, space);
      return space;
    },
  };
}

function readFileDataStoreList(
  lists: FileNodeListReader,
  ref: ChunkRef,
  store: Map<string, ChunkRef>,
  skip: (node: FileNode) => void,
): void {
  for (const node of lists.read(ref)) {
    if (node.id === FileNodeId.FileDataStoreObjectReference && node.ref) {
      store.set(new ByteReader(node.body).guid(), node.ref);
    } else {
      skip(node);
    }
  }
}

/** Where an object's data lives, as recorded by its declaring FileNode. */
interface Declaration {
  id: ExGuid;
  jcid: number;
  ref: ChunkRef | null;
  gids: GlobalIdTable;
  fileReference?: string;
  fileExtension?: string;
}

type GlobalIdTable = Map<number, string>;

interface Revision {
  id: ExGuid;
  dependency: ExGuid;
  encrypted: boolean;
  /** Index range of this revision's nodes in the revision manifest list. */
  first: number;
  end: number;
  /** The revision's own global id table, for GlobalIdTableEntry2/3 in later revisions. */
  gids?: GlobalIdTable;
}

function loadObjectSpace(
  lists: FileNodeListReader,
  id: ExGuid,
  manifestListRef: ChunkRef,
  fileDataStore: Map<string, ChunkRef>,
  skip: (node: FileNode) => void,
): ObjectSpace {
  // [MS-ONESTORE] 2.1.6: only the last revision manifest list reference counts.
  let revisionListRef: ChunkRef | null = null;
  for (const node of lists.read(manifestListRef)) {
    if (node.id === FileNodeId.RevisionManifestListReference) revisionListRef = node.ref;
    else if (node.id !== FileNodeId.ObjectSpaceManifestListStart) skip(node);
  }
  if (!revisionListRef) throw new FormatError(`Object space ${id} has no revision manifest list`, manifestListRef.stp);

  const nodes = lists.read(revisionListRef);
  const revisions = new Map<ExGuid, Revision>();
  // Label pair "context|role" → revision id; later associations replace earlier ones (2.1.11).
  const labels = new Map<string, ExGuid>();
  let open: Revision | undefined;
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!;
    const r = new ByteReader(node.body);
    switch (node.id) {
      case FileNodeId.RevisionManifestStart4:
      case FileNodeId.RevisionManifestStart6:
      case FileNodeId.RevisionManifestStart7: {
        const rid = r.extendedGuid();
        const dependency = r.extendedGuid();
        if (node.id === FileNodeId.RevisionManifestStart4) r.skip(8);
        const role = r.u32();
        const odcs = r.u16();
        const context = node.id === FileNodeId.RevisionManifestStart7 ? r.extendedGuid() : NIL_EXGUID;
        open = { id: rid, dependency, encrypted: odcs === 2, first: i + 1, end: i + 1 };
        revisions.set(rid, open);
        labels.set(`${context}|${role}`, rid);
        break;
      }
      case FileNodeId.RevisionManifestEnd:
        if (open) open.end = i;
        open = undefined;
        break;
      case FileNodeId.RevisionRoleDeclaration: {
        const rid = r.extendedGuid();
        labels.set(`${NIL_EXGUID}|${r.u32()}`, rid);
        break;
      }
      case FileNodeId.RevisionRoleAndContextDeclaration: {
        const rid = r.extendedGuid();
        const role = r.u32();
        labels.set(`${r.extendedGuid()}|${role}`, rid);
        break;
      }
      case FileNodeId.RevisionManifestListStart:
        break;
      default:
        if (!open) skip(node);
    }
  }
  if (open) open.end = nodes.length;

  const currentId = labels.get(`${NIL_EXGUID}|${RootRole.DefaultContent}`);
  const chain: Revision[] = [];
  const inChain = new Set<ExGuid>();
  for (let rid = currentId; rid && rid !== NIL_EXGUID && !inChain.has(rid); ) {
    const revision = revisions.get(rid);
    if (!revision) break;
    inChain.add(rid);
    chain.unshift(revision);
    rid = revision.dependency;
  }

  const declarations = new Map<ExGuid, Declaration>();
  const roots = new Map<number, ExGuid>();
  let encrypted = false;
  let previous: Revision | undefined;
  for (const revision of chain) {
    encrypted ||= revision.encrypted;
    let gids: GlobalIdTable = new Map();
    for (let i = revision.first; i < revision.end; i++) {
      const node = nodes[i]!;
      switch (node.id) {
        case FileNodeId.ObjectGroupListReference:
          if (node.ref) readObjectGroup(lists, node.ref, declarations, skip);
          break;
        case FileNodeId.RootObjectReference3: {
          const r = new ByteReader(node.body);
          const oid = r.extendedGuid();
          roots.set(r.u32(), oid);
          break;
        }
        case FileNodeId.RootObjectReference2: {
          const r = new ByteReader(node.body);
          const oid = resolveCompactId(gids, r.u32());
          const role = r.u32();
          if (oid) roots.set(role, oid);
          break;
        }
        case FileNodeId.ObjectDataEncryptionKeyV2:
          encrypted = true;
          break;
        case FileNodeId.GlobalIdTableStart:
        case FileNodeId.GlobalIdTableStart2:
          gids = new Map();
          break;
        case FileNodeId.GlobalIdTableEntry2:
        case FileNodeId.GlobalIdTableEntry3:
          copyGlobalIds(node, gids, previous?.gids);
          break;
        case FileNodeId.ObjectInfoDependencyOverrides:
        case FileNodeId.DataSignatureGroupDefinition:
        case FileNodeId.GlobalIdTableEnd:
          break;
        default:
          if (!readDeclaration(node, gids, declarations)) skip(node);
      }
    }
    revision.gids = gids;
    previous = revision;
  }

  const objects = new Map<ExGuid, StoreObject | undefined>();
  const object = (oid: ExGuid): StoreObject | undefined => {
    if (objects.has(oid)) return objects.get(oid);
    const declaration = declarations.get(oid);
    const result = declaration ? materialize(lists.bytes, declaration, fileDataStore, encrypted) : undefined;
    objects.set(oid, result);
    return result;
  };
  return {
    id,
    encrypted,
    root: (role) => {
      const oid = roots.get(role);
      return oid ? object(oid) : undefined;
    },
    object,
    objectIds: () => declarations.keys(),
  };
}

/** An object group ([MS-ONESTORE] 2.1.13): its own global id table, then declarations. */
function readObjectGroup(
  lists: FileNodeListReader,
  ref: ChunkRef,
  declarations: Map<ExGuid, Declaration>,
  skip: (node: FileNode) => void,
): void {
  let gids: GlobalIdTable = new Map();
  for (const node of lists.read(ref)) {
    switch (node.id) {
      case FileNodeId.GlobalIdTableStart:
      case FileNodeId.GlobalIdTableStart2:
        gids = new Map();
        break;
      case FileNodeId.ObjectGroupStart:
      case FileNodeId.ObjectGroupEnd:
      case FileNodeId.GlobalIdTableEnd:
      case FileNodeId.DataSignatureGroupDefinition:
        break;
      default:
        if (!readDeclaration(node, gids, declarations)) skip(node);
    }
  }
}

/**
 * Handles the global id table entries and every object declaring or revising
 * FileNode ([MS-ONESTORE] 2.1.5). Returns false for any other node.
 */
function readDeclaration(node: FileNode, gids: GlobalIdTable, declarations: Map<ExGuid, Declaration>): boolean {
  const r = new ByteReader(node.body);
  const declare = (compactId: number, jcid: number, ref: ChunkRef | null, extra?: Partial<Declaration>) => {
    const oid = resolveCompactId(gids, compactId);
    if (oid) declarations.set(oid, { id: oid, jcid, ref, gids, ...extra });
  };
  switch (node.id) {
    case FileNodeId.GlobalIdTableEntry: {
      const index = r.u32();
      gids.set(index, r.guid());
      return true;
    }
    case FileNodeId.ObjectDeclaration2RefCount:
    case FileNodeId.ObjectDeclaration2LargeRefCount:
    case FileNodeId.ReadOnlyObjectDeclaration2RefCount:
    case FileNodeId.ReadOnlyObjectDeclaration2LargeRefCount: {
      // ObjectDeclaration2Body ([MS-ONESTORE] 2.6.16): oid, jcid, flags.
      const compactId = r.u32();
      declare(compactId, r.u32(), node.ref);
      return true;
    }
    case FileNodeId.ObjectDeclarationWithRefCount:
    case FileNodeId.ObjectDeclarationWithRefCount2: {
      // ObjectDeclarationWithRefCountBody ([MS-ONESTORE] 2.6.15): only JCID.index is stored.
      const compactId = r.u32();
      const jci = r.u16() & 0x3ff;
      declare(compactId, 0x20000 | jci, node.ref);
      return true;
    }
    case FileNodeId.ObjectRevisionWithRefCount:
    case FileNodeId.ObjectRevisionWithRefCount2: {
      const compactId = r.u32();
      // A revision keeps the JCID of the object it revises (2.1.5); 0x20001 is the .onetoc2 property container.
      const earlier = declarations.get(resolveCompactId(gids, compactId) ?? '');
      declare(compactId, earlier?.jcid ?? 0x20001, node.ref);
      return true;
    }
    case FileNodeId.ObjectDeclarationFileData3RefCount:
    case FileNodeId.ObjectDeclarationFileData3LargeRefCount: {
      const compactId = r.u32();
      const jcid = r.u32();
      r.skip(node.id === FileNodeId.ObjectDeclarationFileData3RefCount ? 1 : 4);
      const fileReference = readStorageString(r);
      const fileExtension = readStorageString(r);
      declare(compactId, jcid, null, { fileReference, fileExtension });
      return true;
    }
    default:
      return false;
  }
}

/** GlobalIdTableEntry2FNDX and GlobalIdTableEntry3FNDX copy entries from the dependency revision. */
function copyGlobalIds(node: FileNode, gids: GlobalIdTable, from: GlobalIdTable | undefined): void {
  const r = new ByteReader(node.body);
  if (node.id === FileNodeId.GlobalIdTableEntry2) {
    const source = from?.get(r.u32());
    const to = r.u32();
    if (source) gids.set(to, source);
    return;
  }
  const fromStart = r.u32();
  const count = Math.min(r.u32(), 0xffffff);
  const toStart = r.u32();
  for (let i = 0; i < count; i++) {
    const source = from?.get(fromStart + i);
    if (source) gids.set(toStart + i, source);
  }
}

/** A StringInStorageBuffer ([MS-ONESTORE] 2.2.3). */
function readStorageString(r: ByteReader): string {
  const cch = r.u32();
  if (cch * 2 > r.remaining) throw new FormatError(`String of ${cch} characters overruns its FileNode`, r.pos - 4);
  return decodeUtf16(r.take(cch * 2));
}

export function resolveCompactId(gids: GlobalIdTable, compactId: number): ExGuid | null {
  const guid = gids.get(compactId >>> 8);
  return guid ? exGuid(guid, compactId & 0xff) : null;
}

const FILE_DATA_HEADER = 'bde316e7-2665-4511-a4c4-8d4d0b7a9eac';
const IS_FILE_DATA = 0x80000;

function materialize(
  bytes: Uint8Array,
  declaration: Declaration,
  fileDataStore: Map<string, ChunkRef>,
  encrypted: boolean,
): StoreObject {
  const { id, jcid } = declaration;
  if (declaration.fileReference !== undefined || (jcid & IS_FILE_DATA) !== 0) {
    return { id, jcid, props: PropertySet.EMPTY, file: resolveFileData(bytes, declaration, fileDataStore) };
  }
  if (encrypted) return { id, jcid, props: PropertySet.EMPTY, damage: 'encrypted' };
  if (!declaration.ref) return { id, jcid, props: PropertySet.EMPTY };
  const { stp, cb } = declaration.ref;
  try {
    const props = readObjectPropSet(bytes, stp, stp + cb, (compactId) => resolveCompactId(declaration.gids, compactId));
    return { id, jcid, props };
  } catch (e) {
    return { id, jcid, props: PropertySet.EMPTY, damage: e instanceof Error ? e.message : String(e) };
  }
}

/** Follows a FileDataReference ([MS-ONESTORE] 2.5.27) to a FileDataStoreObject (2.6.13). */
function resolveFileData(bytes: Uint8Array, declaration: Declaration, fileDataStore: Map<string, ChunkRef>): FileData {
  const reference = declaration.fileReference ?? '';
  const extension = declaration.fileExtension ?? '';
  if (reference.startsWith('<file>')) return { kind: 'external', extension };
  const match = /^<ifndf>\{([0-9a-fA-F-]{36})\}/.exec(reference);
  const ref = match ? fileDataStore.get(match[1]!.toLowerCase()) : undefined;
  if (!ref) return { kind: 'missing', extension };
  try {
    const r = new ByteReader(bytes, ref.stp, ref.stp + ref.cb);
    if (r.guid() !== FILE_DATA_HEADER) return { kind: 'missing', extension };
    const length = r.u64();
    r.skip(12);
    return { kind: 'stored', data: r.take(length), extension };
  } catch {
    return { kind: 'missing', extension };
  }
}
