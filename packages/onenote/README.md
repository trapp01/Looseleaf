# @looseleaf/onenote

Reads OneNote section files (`.one`) into the import tree
(`packages/model/src/import-tree.ts`). It is written from Microsoft's
published Open Specifications, [MS-ONESTORE] (revision store file format) and
[MS-ONE] (OneNote file format), and from nothing else. It has no dependencies,
no Node APIs and no DOM, so it runs in the browser and in a mobile shell.

```ts
readOneSection(bytes, { name })                 // one .one file → ImportedSection
readNotebookFolder(files, { name })             // { path, bytes }[] → ImportedNotebook
readNotebookFolderLazily(files, { name })       // { path, read() }[] → Promise<ImportedNotebook>, one file in memory at a time
```

A whole file that cannot be read throws a subclass of `OneNoteReadError`:
`NotOneNoteFileError`, `UnsupportedPackagingError`, `EncryptedSectionError` or
`DamagedFileError`. A problem inside a readable file becomes a warning on the
page it affects.

## Layout

| File | Job |
| --- | --- |
| `bytes.ts` | Bounds-checked reading, GUID, ExtendedGUID, CompactID, chunk references, text decoding |
| `file-node-list.ts` | Header, transaction log, file node list fragments |
| `property-set.ts` | ObjectSpaceObjectPropSet and PropertySet, references resolved |
| `revision-store.ts` | Object spaces at their current revision, objects, file data |
| `file-node-ids.ts`, `property-ids.ts`, `jcids.ts` | Spec tables, named as in the spec |
| `section.ts` | Section → pages: title, level, times |
| `page-content.ts` | Outlines, lists, tables, pictures, files, ink counting |
| `rich-text.ts` | Paragraph text, runs, formatting, links, styles, tags |
| `mime.ts` | Media types from signatures and extensions |
| `notebook-folder.ts` | Folders → section groups, backup names, newest copy |

Layout lengths in [MS-ONE] are half-inch increments; the reader converts them
at 48 CSS px per half-inch. Font sizes are half-points and become pt.

## What it imports

- Pages in section order, with title, level (0–2), created and modified time.
  Only the current version is read; conflict pages, version history and
  pages marked deleted are skipped.
- Outlines as text containers at their position and width.
- Paragraph text in both text encodings, split into runs with bold, italic,
  underline, strikethrough, superscript, subscript, font, size, colour and
  highlight. Black text and white highlight are dropped so text follows the
  app's theme.
- Links, both the plain form and the `U+FDDF HYPERLINK "…"` field-code form.
- Paragraph alignment; styles h1–h6, quote, code and citation.
- Indentation of paragraphs nested under plain paragraphs, one step per level.
- Bulleted and numbered lists, nested inside their items; neighbouring items
  of one kind are merged into one list.
- Note tags: to-do (with its checked state), important, question, remember
  for later, definition. Other tags become a warning.
- Tables with column widths, cell shading and cell content.
- Pictures from the file's data store, inline or placed on the page, with
  their displayed size and alt text.
- Attached files, including audio and video recordings, as file containers.
- Section colour.

## What it does not import

- Ink. Strokes are counted and reported as a page warning; see below.
- Section order from the notebook's `.onetoc2`; sections are alphabetical.
- Sections in the packaging OneDrive downloads use ([MS-ONESTORE] 2.7–2.8):
  `UnsupportedPackagingError`.
- Password-protected sections: `EncryptedSectionError`.
- Pictures and files whose data sits in a `onefiles` folder beside the section
  (`<file>` references): a warning.
- Indentation of lists nested under a plain paragraph: the import tree's
  lists have no indent, so such lists sit at the paragraph's level. This is
  the common case in real notes.
- OutlineElementChildLevel values above 1: each nesting level is one step.
- Numbering that restarts at a set number, and number formats (a., i., …).
- Links on pictures and tags on pictures, tables and files: warnings.
- Equations (imported as plain text), embedded objects inside text.
- Attached files inside an outline are moved out to a file container at the
  outline's corner, since the import tree has no inline file block.
- Raw bitmaps (DIB), EMF, WMF and TIFF pictures are kept as is with a warning,
  since browsers do not show them.
- CRCs are not verified.

## Where to find `.one` files

- **OneNote for Mac** keeps notebooks in the cloud. Its local backups, one
  folder per notebook with dated section copies, are in
  `~/Library/Containers/com.microsoft.onenote.mac/Data/Library/Application Support/Microsoft User Data/OneNote/15.0/Backup/`.
  Feed a notebook's backup folder to `readNotebookFolder`; the reader keeps
  the newest copy of each section and skips `OneNote_RecycleBin`.
- **OneNote for Windows** (the desktop app) keeps local notebooks in
  `Documents\OneNote Notebooks\<notebook>\` and backups in
  `%LOCALAPPDATA%\Microsoft\OneNote\16.0\Backup\`. File › Export › Section
  writes a `.one` in the format this reader handles.
- A section downloaded from OneDrive on the web is in the packaging this
  reader does not support yet.

Backup copies are named `Name.one (On 2024-05-01).one`, `Name (On 2024-05-01).one`
or `Name (On 2024-05-01 - 2).one`, and a backup of a backup repeats the
suffix. A file without a suffix is the live section and beats any backup;
otherwise the outermost date wins, then the copy number.

## Where the files differ from the specification

Found by reading OneNote for Mac backups; each is handled in the module named.

- **Transaction log fragments** (`file-node-list.ts`): `nextFragment` follows
  the last whole TransactionEntry, and the fragment can end with 4 bytes of
  padding after it, so it is not at the fragment's end as 2.3.3.1 implies.
- **NotebookColor** (`property-ids.ts`): its PropertyID is missing from the
  [MS-ONE] 2.1.12 table. 0x14001CBE is the one 4-byte property on
  jcidSectionMetaData besides the two schema revisions.
- **Section colour byte order** (`section.ts`): values match OneNote's section
  palette only when read as 0x00bbggrr, like a COLORREF. The example in
  [MS-ONE] 3.1 implies the opposite order.
- **IsDeletedGraphSpaceContent** (`section.ts`): the table lists it with type
  0x7 (length-prefixed data), but files store it as a Bool (type 0x2). Both
  are accepted.
- **Ink** (`jcids.ts`): no ink structure is in [MS-ONE]. JCID 0x00060014 sits
  in a page's child list with a position and bounding box, and leads to one
  0x00020047 object per stroke. Stroke point data is in properties
  (0x340B and others) that no published document describes, and it is not an
  Ink Serialized Format stream (no ISF header). Decoding it would be guessing,
  so the reader only counts strokes.
- **The table of contents properties** (TOCEntryIndex_OidIndex,
  FolderChildFilename, NotebookElementOrderingID, FileIdentityGuid) have no
  PropertyIDs in the 2.1.12 table, which is why `.onetoc2` ordering is not
  read.
- The JCID table in [MS-ONE] 2.1.13 lists FileNodeIDs 0xA1/0xA2 for most
  property sets; files use 0xA4/0xA5 (ObjectDeclaration2RefCountFND and its
  large form), as [MS-ONESTORE] 2.5.25–26 says.

## Tests

`pnpm --filter @looseleaf/onenote test` runs unit tests on hand-built bytes
(`test/store-builder.ts` writes whole synthetic section files). Real notebooks
never enter the repo. To run against a folder of real files:

```sh
LOOSELEAF_ONE_SAMPLES=/path/to/folder pnpm --filter @looseleaf/onenote test
```

The corpus test reads every `.one` under the folder, fails on any error that is
not a `OneNoteReadError`, and prints totals and warnings.
