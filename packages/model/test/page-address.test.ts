import { describe, expect, it } from 'vitest';
import { appPageAddress, pageHash, pageIdFromAppAddress, pageIdFromHash } from '../src/page-address.js';

const PAGE = 'V1StGXR8_Z5jdHi6B-myT';

describe('page address', () => {
  it('reads back the page id it wrote into a fragment', () => {
    expect(pageHash(PAGE)).toBe(`#page=${PAGE}`);
    expect(pageIdFromHash(pageHash(PAGE))).toBe(PAGE);
  });

  it('reads back the page id it wrote into an app address', () => {
    expect(appPageAddress(PAGE)).toBe(`looseleaf://page/${PAGE}`);
    expect(pageIdFromAppAddress(appPageAddress(PAGE))).toBe(PAGE);
  });

  it('accepts the app address as an operating system may hand it over', () => {
    expect(pageIdFromAppAddress(`LOOSELEAF://page/${PAGE}`)).toBe(PAGE);
    expect(pageIdFromAppAddress(`looseleaf://page/${PAGE}/`)).toBe(PAGE);
  });

  it('answers null for anything that is not a page address', () => {
    for (const hash of ['', '#', '#page=', '#page=a b', '#page=<script>', '#section=abc', `page=${PAGE}`]) {
      expect(pageIdFromHash(hash)).toBeNull();
    }
    for (const address of ['', 'looseleaf://page/', 'looseleaf://section/abc', `https://example.org/#page=${PAGE}`, 'looseleaf://page/a/b', '--flag']) {
      expect(pageIdFromAppAddress(address)).toBeNull();
    }
  });
});
