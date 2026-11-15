import { describe, expect, it } from 'vitest';
import { isBrowserImage, mimeFor, sniffMime } from '../src/mime.js';

const pad = (head: number[], length = 64) => Uint8Array.from([...head, ...new Array(Math.max(0, length - head.length)).fill(0)]);

describe('sniffMime', () => {
  it('recognises picture signatures', () => {
    expect(sniffMime(pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image/png');
    expect(sniffMime(pad([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffMime(pad([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBe('image/gif');
    expect(sniffMime(pad([0x42, 0x4d]))).toBe('image/bmp');
    expect(sniffMime(pad([0x49, 0x49, 0x2a, 0x00]))).toBe('image/tiff');
    expect(sniffMime(pad([0xd7, 0xcd, 0xc6, 0x9a]))).toBe('image/wmf');
    const emf = pad([0x01, 0, 0, 0]);
    emf.set([0x20, 0x45, 0x4d, 0x46], 40);
    expect(sniffMime(emf)).toBe('image/emf');
    expect(sniffMime(pad([0x25, 0x50, 0x44, 0x46, 0x2d]))).toBe('application/pdf');
  });

  it('returns undefined for unknown or short data', () => {
    expect(sniffMime(Uint8Array.from([0x89, 0x50]))).toBeUndefined();
    expect(sniffMime(pad([1, 2, 3]))).toBeUndefined();
  });
});

describe('mimeFor', () => {
  it('prefers the signature, then the extension, then octet-stream', () => {
    expect(mimeFor(pad([0xff, 0xd8, 0xff]), '.png')).toBe('image/jpeg');
    expect(mimeFor(pad([1, 2, 3]), 'notes.TXT')).toBe('text/plain');
    expect(mimeFor(pad([1, 2, 3]), '')).toBe('application/octet-stream');
  });

  it('keeps an Office extension over the zip signature', () => {
    expect(mimeFor(pad([0x50, 0x4b, 0x03, 0x04]), 'plan.docx')).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(mimeFor(pad([0x50, 0x4b, 0x03, 0x04]), 'bundle')).toBe('application/zip');
  });

  it('knows which pictures a browser shows', () => {
    expect(isBrowserImage('image/png')).toBe(true);
    expect(isBrowserImage('image/emf')).toBe(false);
  });
});
