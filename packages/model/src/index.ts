/**
 * @looseleaf/model: what a library, notebook, page, container and board are,
 * the rich-text schema, To Do lines, reading and writing them in Yjs docs,
 * export, mirror planning, and import from an import tree or from Markdown.
 * No DOM, network or storage; runs in Node and browsers.
 */
export { newId, LIBRARY_DOC_ID, notebookDocId, pageDocId, boardDocId, notebookIdOfBoardDoc } from './ids.js';
export { APP_ADDRESS_SCHEME, appPageAddress, pageHash, pageIdFromAppAddress, pageIdFromHash } from './page-address.js';
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
  listNodes,
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
  livePages,
  type LivePage,
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
  textContainerBodies,
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
export {
  SYSTEM_STAMP,
  tagTodoLine,
  copyTodoLine,
  stampTodoLines,
  todoLinePlugin,
  type TodoLineStamp,
} from './todo-line-ids.js';
export {
  listTodoLines,
  changeTodoLines,
  setTodoLineChecked,
  keepAsLine,
  appendTodoLine,
  turnLineIntoCardLink,
  removeDuplicateCardLinks,
  type TodoLine,
} from './todo-lines.js';
export { LABEL_COLORS, DEFAULT_LABEL_COLOR, isLabelColor, labelColorOr, leastUsedLabelColor, type LabelColor } from './board/colors.js';
export {
  STATUS_KINDS,
  readBoard,
  readBoardMeta,
  readStatuses,
  readLabels,
  shownStatusId,
  cardsInStatus,
  shownCards,
  archivedCards,
  findStatus,
  findCard,
  cardLabels,
  cardPageIds,
  checklistProgress,
  type StatusKind,
  type BoardMeta,
  type Status,
  type Label,
  type Comment,
  type Link,
  type Activity,
  type Card,
  type BoardSnapshot,
} from './board/board.js';
export {
  BOARD_KEY_MAX_LENGTH,
  normalizeBoardKey,
  suggestBoardKey,
  createBoard,
  setBoardKey,
  boardKeyRepairs,
} from './board/keys.js';
export {
  DEFAULT_STATUSES,
  createStatus,
  updateStatus,
  moveStatus,
  archiveStatus,
  restoreStatus,
  createLabel,
  updateLabel,
  deleteLabel,
} from './board/statuses.js';
export {
  nextCardNumber,
  putOnBoard,
  setCardDue,
  moveCard,
  archiveCard,
  restoreCard,
  addComment,
  editComment,
  deleteComment,
  clearDeletedComments,
  addLink,
  removeLink,
  renumberDuplicateCards,
  type CardPlace,
  type PutOnBoard,
} from './board/cards.js';
export {
  UNFILED_SECTION_NAME,
  unfiledSectionId,
  ensureUnfiledSection,
  filingSection,
  recordUnfiled,
  addCard,
  labelCard,
  type DocAccess,
  type NewCard,
} from './board/filing.js';
export { promoteTodoLine, type PromoteLine } from './board/promote.js';
export { writeBoardRecord, writeCardRecord, type BoardRecord, type CardRecord } from './board/records.js';
export { inboxLines, type InboxLine, type InboxInput } from './board/inbox.js';
export { formatCardRef, parseCardRef, looseleafTarget, parseLinkTarget, type LinkTarget } from './board/refs.js';
export { searchCards, type CardFilter } from './board/search.js';
export { renderBoard, renderCard, renderCardLine, type RenderOptions, type BoardRenderOptions, type CardRenderOptions } from './board/render.js';
