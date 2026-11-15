/**
 * @looseleaf/onenote reads OneNote section files (`.one`, the desktop revision
 * store layout) into the import tree. It is written from Microsoft's
 * [MS-ONESTORE] and [MS-ONE] Open Specifications and runs anywhere JavaScript
 * does: no Node APIs, no DOM.
 */
export { readOneSection } from './section.js';
export {
  readNotebookFolder,
  readNotebookFolderLazily,
  type LazyNotebookFile,
  type NotebookFile,
} from './notebook-folder.js';
export {
  DamagedFileError,
  EncryptedSectionError,
  NotOneNoteFileError,
  OneNoteReadError,
  UnsupportedPackagingError,
} from './errors.js';
