import { describe, expect, it } from 'vitest';
import { imageSize } from '../src/image-size.js';
import { pngBytes } from './corkboard-fixture.js';

describe('imageSize', () => {
  it('reads PNG, GIF, JPEG and WebP headers', () => {
    expect(imageSize(pngBytes(1280, 720))).toEqual({ width: 1280, height: 720 });
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x20, 0x01, 0x10, 0x00]);
    expect(imageSize(gif)).toEqual({ width: 288, height: 16 });
    // SOI, an APP0 segment of 4 bytes, then SOF0 with height 300 and width 400.
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x2c, 0x01, 0x90, 0x03]);
    expect(imageSize(jpeg)).toEqual({ width: 400, height: 300 });
    const webp = new Uint8Array(30);
    webp.set(new TextEncoder().encode('RIFF'), 0);
    webp.set(new TextEncoder().encode('WEBPVP8X'), 8);
    webp.set([99, 0, 0, 49, 0, 0], 24);
    expect(imageSize(webp)).toEqual({ width: 100, height: 50 });
  });

  it('answers null for bytes that are no picture it reads', () => {
    expect(imageSize(new TextEncoder().encode('%PDF-1.7 invented'))).toBeNull();
    expect(imageSize(new Uint8Array([0xff, 0xd8, 0x00]))).toBeNull();
  });
});
