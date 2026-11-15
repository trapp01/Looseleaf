/**
 * The errors a reader throws when a whole file cannot be read. Each carries the
 * file name and a short description of what was found instead. Anything wrong
 * inside a readable file becomes a page warning instead of an error.
 */
export class OneNoteReadError extends Error {
  constructor(
    message: string,
    readonly fileName: string,
    readonly found: string,
  ) {
    super(`${fileName}: ${message} (${found})`);
    this.name = new.target.name;
  }
}

/** The bytes are not a OneNote section or table of contents file. */
export class NotOneNoteFileError extends OneNoteReadError {}

/**
 * A section in the packaging OneDrive downloads use ([MS-ONESTORE] 2.8,
 * File Synchronization via SOAP over HTTP). This reader handles only the
 * desktop revision store layout of 2.1–2.6.
 */
export class UnsupportedPackagingError extends OneNoteReadError {}

/** A password-protected section; its pages cannot be read without the password. */
export class EncryptedSectionError extends OneNoteReadError {}

/** A revision store file whose header, root list or section root cannot be read. */
export class DamagedFileError extends OneNoteReadError {}
