/**
 * @looseleaf/model: what a library, notebook, page and container are, the
 * rich-text schema, reading and writing them in Yjs docs, export, mirror
 * planning, and import from an import tree or from Markdown. No DOM, network or storage; runs in Node and browsers.
 */
export { newId, LIBRARY_DOC_ID, notebookDocId, pageDocId } from './ids.js';
export { sortByOrder, orderAt, type Ordered } from './order.js';
export { COLORS, colorHex, isColorName, nearestColor, type ColorName } from './colors.js';
export {
  richTextExtensions,
  richTextSchema,
  TAGS,
  TAG_LABELS,
  PARAGRAPH_STYLES,
  INDENT_STEP_PX,
  changeIndent,
  emptyBody,
  assertValidBody,
  writeBody,
  readBody,
  bodyToText,
  type TagName,
  type ParagraphStyle,
  type JSONContent,
} from './rich-text.js';
export {
  listNotebooks,
  getNotebook,
  createNotebook,
  renameNotebook,
  setNotebookColor,
  moveNotebook,
  deleteNotebook,
  restoreNotebook,
  purgeNotebook,
  type NotebookEntry,
} from './library.js';
export {
  readTree,
  getNode,
  listDeletedNodes,
  createGroup,
  createSection,
  createPage,
  renameNode,
  setSectionColor,
  moveNode,
  setPageLevel,
  deleteNode,
  restoreNode,
  purgeNode,
  touchNode,
  type NodeKind,
  type PageLevel,
  type NodeEntry,
  type PageEntry,
  type SectionEntry,
  type GroupEntry,
  type TreeChild,
  type NotebookTree,
  type Placement,
} from './notebook.js';
export {
  PAPER_STYLES,
  PAPER_SPACING,
  readPageMeta,
  setPaperStyle,
  setPaperColor,
  addTextContainer,
  appendToPage,
  addImageContainer,
  addFileContainer,
  moveContainer,
  resizeContainer,
  restackContainer,
  deleteContainer,
  textContainerBody,
  addStroke,
  deleteStroke,
  readPage,
  extractPageText,
  type PaperStyle,
  type PageMeta,
  type BlobRef,
  type TextContainer,
  type ImageContainer,
  type FileContainer,
  type Container,
  type Stroke,
  type StrokeTool,
  type PageSnapshot,
  type Restack,
} from './page.js';
export {
  exportPage,
  exportZip,
  type DocSource,
  type ExportFormat,
  type ExportScope,
  type ExportFile,
} from './export/bundle.js';
export type { PageJson } from './export/json.js';
export {
  MIRROR_MANIFEST_FILE,
  MIRROR_ASSETS_FOLDER,
  isSafeMirrorPath,
  mirrorOwnedPaths,
  parseMirrorManifest,
  serializeMirrorManifest,
  type MirrorManifest,
  type MirrorPage,
} from './mirror/manifest.js';
export { planMirror, type MirrorPlanInput, type MirrorPlan, type MirrorAssetWrite } from './mirror/plan.js';
export { importTree, type DocSink, type ImportSummary } from './import.js';
export { markdownToBody, type MarkdownBody } from './import-markdown.js';
export type * from './import-tree.js';
