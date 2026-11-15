import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  decodeFrame,
  decodeHello,
  decodeWelcome,
  encodeFrame,
  encodeHello,
  encodeWelcome,
  FrameType,
  normalizeServerAddress,
  routeUrl,
  socketUrl,
} from '../src/protocol.js';

describe('binary frames', () => {
  it.each([FrameType.StateVector, FrameType.Diff, FrameType.Update])('round-trips frame type %i', (type) => {
    const doc = new Y.Doc();
    doc.getText('t').insert(0, 'héllo');
    const payload = Y.encodeStateAsUpdate(doc);
    const decoded = decodeFrame(encodeFrame({ type, docId: 'pg:Ab-_ü/é', payload }));
    expect(decoded.type).toBe(type);
    expect(decoded.docId).toBe('pg:Ab-_ü/é');
    expect([...decoded.payload]).toEqual([...payload]);
  });

  it('lays a frame out as varuint type, varstring doc id, then the payload to the end', () => {
    const bytes = encodeFrame({ type: FrameType.Update, docId: 'ab', payload: new Uint8Array([7, 8]) });
    expect([...bytes]).toEqual([2, 2, 97, 98, 7, 8]);
  });

  it('round-trips an empty payload', () => {
    const decoded = decodeFrame(encodeFrame({ type: FrameType.Diff, docId: 'library', payload: new Uint8Array() }));
    expect(decoded.payload).toHaveLength(0);
  });

  it('rejects unknown types, empty doc ids and truncated frames', () => {
    expect(() => decodeFrame(new Uint8Array([9, 1, 97]))).toThrow(/Unknown sync frame type 9/);
    expect(() => decodeFrame(new Uint8Array([0, 0]))).toThrow(/empty doc id/);
    expect(() => decodeFrame(new Uint8Array([0, 10, 97]))).toThrow(/Malformed sync frame/);
    expect(() => decodeFrame(new Uint8Array([]))).toThrow();
  });
});

describe('text frames', () => {
  it('round-trips hello and welcome in the documented shape', () => {
    expect(JSON.parse(encodeHello('tok', 'r1'))).toEqual({ t: 'hello', token: 'tok', replica: 'r1', v: 1 });
    expect(decodeHello(encodeHello('tok', 'r1'))).toEqual({ t: 'hello', token: 'tok', replica: 'r1', v: 1 });
    expect(decodeWelcome(encodeWelcome(['library', 'pg:a']))).toEqual({ t: 'welcome', docs: ['library', 'pg:a'] });
  });

  it('rejects anything else', () => {
    expect(() => decodeHello('{"t":"welcome","docs":[]}')).toThrow(/Expected a hello/);
    expect(() => decodeHello('not json')).toThrow(/not JSON/);
    expect(() => decodeWelcome('{"t":"welcome","docs":[1]}')).toThrow(/Expected a welcome/);
    expect(() => decodeWelcome('null')).toThrow(/Expected a welcome/);
  });
});

describe('server addresses', () => {
  it('normalizes and builds route and socket URLs', () => {
    expect(normalizeServerAddress(' http://nas:8421/ ')).toBe('http://nas:8421');
    expect(normalizeServerAddress('https://host.ts.net/looseleaf/')).toBe('https://host.ts.net/looseleaf');
    expect(socketUrl('http://nas:8421')).toBe('ws://nas:8421/sync');
    expect(socketUrl('https://host.ts.net/looseleaf')).toBe('wss://host.ts.net/looseleaf/sync');
    expect(routeUrl('http://nas:8421', '/api/blobs')).toBe('http://nas:8421/api/blobs');
  });

  it('rejects addresses that are not http(s)', () => {
    expect(() => normalizeServerAddress('nas:8421')).toThrow(/http/);
    expect(() => normalizeServerAddress('ftp://nas')).toThrow(/http/);
    expect(() => normalizeServerAddress('')).toThrow(/not a server address/);
  });
});
