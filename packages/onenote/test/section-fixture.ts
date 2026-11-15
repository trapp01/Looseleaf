// A synthetic section file laid out as [MS-ONE] 3.1 describes: a section object
// space whose page series points at one page object space per page.
import { Jcid } from '../src/jcids.js';
import { PropertyId as P } from '../src/property-ids.js';
import { buildRevisionStore, testGuid, utf16z, Writer, type TestObject, type TestProp, type TestSpace } from './store-builder.js';

export interface FixturePage {
  title: string;
  paragraphs: string[];
  /** PageLevel as stored: 1 for a top page. */
  pageLevel?: number;
  deleted?: boolean;
  picture?: Uint8Array;
  /** Adds a paragraph whose property set is malformed. */
  damagedParagraph?: boolean;
}

const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0));
const f32 = (v: number) => new Writer().f32(v).bytes;

export const CREATED_FILETIME = 133_500_000_000_000_000; // 2024-01-20T…Z
export const MODIFIED_TIME32 = 1_400_000_000; // seconds after 1980-01-01

export function buildSectionFile(pages: FixturePage[], options: { encryptedSection?: boolean; missingPageSpace?: boolean } = {}): Uint8Array {
  const sectionSpace = `${testGuid(0x100)}/1`;
  const pageSpaces = pages.map((_, i) => `${testGuid(0x200 + i)}/1`);
  const s = (k: number) => `${testGuid(0x101)}/${k}`;
  const spaces: TestSpace[] = [
    {
      id: sectionSpace,
      encrypted: options.encryptedSection,
      roots: [
        [1, s(1)],
        [2, s(3)],
      ],
      objects: [
        { id: s(1), jcid: Jcid.SectionNode, props: [{ id: P.ElementChildNodes, refs: [s(2)] }] },
        {
          id: s(2),
          jcid: Jcid.PageSeriesNode,
          props: [{ id: P.ChildGraphSpaceElementNodes, refs: options.missingPageSpace ? [...pageSpaces, `${testGuid(0x2ff)}/1`] : pageSpaces }],
        },
        // 0x00e4a88a: blue #8aa8e4 in the 0x00bbggrr layout.
        { id: s(3), jcid: Jcid.SectionMetaData, props: [{ id: P.NotebookColor, data: [0x8a, 0xa8, 0xe4, 0x00] }] },
      ],
    },
  ];
  pages.forEach((page, i) => {
    const o = (k: number) => `${testGuid(0x300 + i)}/${k}`;
    const objects: TestObject[] = [];
    const bodyElements: string[] = [];
    objects.push({ id: o(50), jcid: Jcid.ParagraphStyleObject, props: [{ id: P.Bold, bool: true }] });
    page.paragraphs.forEach((text, j) => {
      const element = o(100 + 2 * j);
      const rich = o(101 + 2 * j);
      bodyElements.push(element);
      objects.push({ id: element, jcid: Jcid.OutlineElementNode, props: [{ id: P.ContentChildNodes, refs: [rich] }] });
      const props: TestProp[] = [{ id: P.RichEditTextUnicode, data: utf16z(text) }];
      // The first word of each paragraph is bold.
      const space = text.indexOf(' ');
      if (space > 0) {
        props.push({ id: P.TextRunIndex, data: new Writer().u32(space).bytes });
        props.push({ id: P.TextRunFormatting, refs: [o(50), o(51)] });
      }
      objects.push({ id: rich, jcid: Jcid.RichTextOENode, props });
    });
    objects.push({ id: o(51), jcid: Jcid.ParagraphStyleObject, props: [] });
    if (page.damagedParagraph) {
      objects.push({ id: o(70), jcid: Jcid.RichTextOENode, raw: [0, 0, 0, 0x80, 1, 0, 0x99, 0x99] });
      objects.push({ id: o(71), jcid: Jcid.OutlineElementNode, props: [{ id: P.ContentChildNodes, refs: [o(70)] }] });
      bodyElements.push(o(71));
    }
    if (page.picture) {
      objects.push({ id: o(60), jcid: Jcid.PictureContainer14, file: { data: page.picture, extension: '.png' } });
      objects.push({ id: o(61), jcid: Jcid.ImageNode, props: [{ id: P.PictureContainer, refs: [o(60)] }, { id: P.PictureWidth, data: f32(2) }] });
      objects.push({ id: o(62), jcid: Jcid.OutlineElementNode, props: [{ id: P.ContentChildNodes, refs: [o(61)] }] });
      bodyElements.push(o(62));
    }
    objects.push(
      { id: o(1), jcid: Jcid.PageManifestNode, props: [{ id: P.ContentChildNodes, refs: [o(2)] }] },
      {
        id: o(2),
        jcid: Jcid.PageNode,
        props: [
          { id: P.StructureElementChildNodes, refs: [o(3)] },
          { id: P.ElementChildNodes, refs: [o(7)] },
          { id: P.LastModifiedTime, data: new Writer().u32(MODIFIED_TIME32).bytes },
        ],
      },
      { id: o(3), jcid: Jcid.TitleNode, props: [{ id: P.ElementChildNodes, refs: [o(4)] }] },
      { id: o(4), jcid: Jcid.OutlineNode, props: [{ id: P.IsTitleText, bool: true }, { id: P.ElementChildNodes, refs: [o(5)] }] },
      { id: o(5), jcid: Jcid.OutlineElementNode, props: [{ id: P.ContentChildNodes, refs: [o(6)] }] },
      { id: o(6), jcid: Jcid.RichTextOENode, props: [{ id: P.TextExtendedAscii, data: ascii(page.title) }] },
      {
        id: o(7),
        jcid: Jcid.OutlineNode,
        props: [
          { id: P.ElementChildNodes, refs: bodyElements },
          { id: P.OffsetFromParentHoriz, data: f32(1) },
          { id: P.OffsetFromParentVert, data: f32(2) },
          { id: P.LayoutMaxWidth, data: f32(12) },
        ],
      },
      {
        id: o(8),
        jcid: Jcid.PageMetaData,
        props: [
          { id: P.PageLevel, data: new Writer().u32(page.pageLevel ?? 1).bytes },
          { id: P.CachedTitleString, data: utf16z(page.title) },
          { id: P.TopologyCreationTimeStamp, data: new Writer().u64(CREATED_FILETIME).bytes },
          // The table lists this Boolean with a length prefix; files store it as a Bool (type 0x2).
          ...(page.deleted ? [{ id: ((P.IsDeletedGraphSpaceContent & 0x3ffffff) | (0x2 << 26)) >>> 0, bool: true }] : []),
        ],
      },
    );
    spaces.push({
      id: pageSpaces[i]!,
      roots: [
        [1, o(1)],
        [2, o(8)],
      ],
      objects,
    });
  });
  return buildRevisionStore(spaces, sectionSpace);
}
