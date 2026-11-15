import { createHash } from 'node:crypto';
import * as Y from 'yjs';
import type { DocSink, DocSource } from '../src/index.js';

/** Brings two replicas of one doc fully in step, as a reconnect would. */
export function syncDocs(a: Y.Doc, b: Y.Doc): void {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
}

/** A second replica that starts from the first one's current state. */
export function forkDoc(doc: Y.Doc): Y.Doc {
  const copy = new Y.Doc();
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
  return copy;
}

export function stateBytes(doc: Y.Doc): Uint8Array {
  return Y.encodeStateAsUpdate(doc);
}

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** An in-memory replica: docs made on first use, blobs keyed by hash. */
export class MemoryReplica implements DocSource, DocSink {
  readonly docs = new Map<string, Y.Doc>();
  readonly blobs = new Map<string, Uint8Array>();

  async getDoc(docId: string): Promise<Y.Doc> {
    let doc = this.docs.get(docId);
    if (!doc) {
      doc = new Y.Doc();
      this.docs.set(docId, doc);
    }
    return doc;
  }

  async getBlob(hash: string): Promise<Uint8Array | null> {
    return this.blobs.get(hash) ?? null;
  }

  async putBlob(bytes: Uint8Array): Promise<string> {
    const hash = sha256(bytes);
    this.blobs.set(hash, bytes);
    return hash;
  }

  doc(docId: string): Y.Doc {
    const doc = this.docs.get(docId);
    if (!doc) throw new Error(`No doc ${docId}`);
    return doc;
  }
}

/** A tiny valid PNG (1x1, transparent). */
export const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00,
  0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0d, 0x49,
  0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00,
  0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);
