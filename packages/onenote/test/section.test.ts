import { describe, expect, it } from 'vitest';
import type { ImportedTextContainer } from '../../model/src/import-tree.js';
import {
  DamagedFileError,
  EncryptedSectionError,
  NotOneNoteFileError,
  readOneSection,
  UnsupportedPackagingError,
} from '../src/index.js';
import { fileTimeToMs, time32ToMs } from '../src/section.js';
import { buildSectionFile, CREATED_FILETIME, MODIFIED_TIME32 } from './section-fixture.js';
import { guidBytes } from './store-builder.js';

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

describe('readOneSection', () => {
  const bytes = buildSectionFile([
    { title: 'First page', paragraphs: ['Hello world', 'Second line'], picture: PNG },
    { title: 'Child page', paragraphs: ['Nested'], pageLevel: 2 },
    { title: 'Gone', paragraphs: [], deleted: true },
    { title: 'Grandchild', paragraphs: [], pageLevel: 3 },
  ]);
  const section = readOneSection(bytes, { name: 'Notes' });

  it('reads pages in page series order with titles and levels, skipping deleted pages', () => {
    expect(section.name).toBe('Notes');
    expect(section.color).toBe('#8aa8e4');
    expect(section.pages.map((p) => [p.title, p.level])).toEqual([
      ['First page', 0],
      ['Child page', 1],
      ['Grandchild', 2],
    ]);
  });

  it('converts creation and modification times to epoch ms', () => {
    const [page] = section.pages;
    expect(page!.createdAt).toBe(fileTimeToMs(CREATED_FILETIME));
    expect(page!.modifiedAt).toBe(time32ToMs(MODIFIED_TIME32));
  });

  it('reads the outline as a text container with formatted runs and the picture bytes', () => {
    const page = section.pages[0]!;
    expect(page.warnings).toEqual([]);
    const container = page.containers[0] as ImportedTextContainer;
    expect(container).toMatchObject({ kind: 'text', x: 48, y: 16, width: 576 });
    expect(container.blocks).toEqual([
      { type: 'paragraph', runs: [{ text: 'Hello', bold: true }, { text: ' world' }] },
      { type: 'paragraph', runs: [{ text: 'Second', bold: true }, { text: ' line' }] },
      { type: 'image', data: PNG, mime: 'image/png', width: 96 },
    ]);
  });

  it('throws typed errors that name the file', () => {
    expect(() => readOneSection(Uint8Array.from([1, 2, 3]), { name: 'tiny.one' })).toThrow(NotOneNoteFileError);
    const packaged = new Uint8Array(bytes.length);
    packaged.set(bytes);
    packaged.set(guidBytes('638de92f-a6d4-4bc1-9a36-b3fc2511a5b7'), 48);
    expect(() => readOneSection(packaged, { name: 'cloud.one' })).toThrow(UnsupportedPackagingError);
    expect(() => readOneSection(packaged, { name: 'cloud.one' })).toThrow(/cloud\.one/);
    const truncated = bytes.subarray(0, 2000);
    expect(() => readOneSection(truncated, { name: 'cut.one' })).toThrow(DamagedFileError);
    const encrypted = buildSectionFile([{ title: 'x', paragraphs: [] }], { encryptedSection: true });
    expect(() => readOneSection(encrypted, { name: 'locked.one' })).toThrow(EncryptedSectionError);
  });

  it('degrades damaged objects and unreadable pages to warnings', () => {
    const file = buildSectionFile([{ title: 'Kept', paragraphs: ['Still here'], damagedParagraph: true }], { missingPageSpace: true });
    const result = readOneSection(file, { name: 'damaged.one' });
    expect(result.pages).toHaveLength(2);
    const [kept, missing] = result.pages;
    expect(kept!.title).toBe('Kept');
    expect((kept!.containers[0] as ImportedTextContainer).blocks).toHaveLength(1);
    expect(kept!.warnings).toEqual(['Damaged content was skipped']);
    expect(missing!.warnings).toEqual(['This page could not be read']);
  });
});

describe('time conversion', () => {
  it('maps FILETIME and Time32 epochs to Unix ms', () => {
    expect(fileTimeToMs(116_444_736_000_000_000 + 10_000)).toBe(1);
    expect(time32ToMs(0)).toBeUndefined();
    expect(time32ToMs(1)).toBe(Date.UTC(1980, 0, 1, 0, 0, 1));
  });
});
