/**
 * JCID values ([MS-ONESTORE] 2.6.14) for the property sets and file data
 * objects of [MS-ONE] 2.1.5 and 2.1.13, named as in the spec.
 */
export const Jcid = {
  ReadOnlyPersistablePropertyContainerForAuthor: 0x00120001,
  SectionNode: 0x00060007,
  PageSeriesNode: 0x00060008,
  PageNode: 0x0006000b,
  OutlineNode: 0x0006000c,
  OutlineElementNode: 0x0006000d,
  RichTextOENode: 0x0006000e,
  ImageNode: 0x00060011,
  NumberListNode: 0x00060012,
  OutlineGroup: 0x00060019,
  TableNode: 0x00060022,
  TableRowNode: 0x00060023,
  TableCellNode: 0x00060024,
  TitleNode: 0x0006002c,
  PageMetaData: 0x00020030,
  SectionMetaData: 0x00020031,
  EmbeddedFileNode: 0x00060035,
  EmbeddedFileContainer: 0x00080036,
  PageManifestNode: 0x00060037,
  ConflictPageMetaData: 0x00020038,
  PictureContainer14: 0x00080039,
  VersionHistoryContent: 0x0006003c,
  VersionProxy: 0x0006003d,
  NoteTagSharedDefinitionContainer: 0x00120043,
  RevisionMetaData: 0x00020044,
  VersionHistoryMetaData: 0x00020046,
  /** jcidParagraphStyleObject and jcidParagraphStyleObjectForText share this value. */
  ParagraphStyleObject: 0x0012004d,
} as const;

/**
 * Not in [MS-ONE]. The ink container sits in a page's child list with a
 * position and a bounding box, and its references lead to one object per
 * stroke. The reader only counts strokes; it does not decode them.
 */
export const InkJcid = {
  InkContainer: 0x00060014,
  InkStroke: 0x00020047,
} as const;
