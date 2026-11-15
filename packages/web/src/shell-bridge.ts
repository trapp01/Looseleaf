/**
 * The one channel between the web client and a native shell. The desktop
 * shell's preload script sets `window.looseleafShell` to an object of this
 * shape; in a plain browser it is absent and every caller falls back to what
 * the browser offers.
 */
export interface ShellBridge {
  kind: 'desktop';
  platform: 'darwin' | 'win32' | 'linux';

  /** Shows a save dialog and writes the bytes. Resolves false when cancelled. */
  saveFile(suggestedName: string, bytes: Uint8Array): Promise<boolean>;

  /** Prints the window's current content to a PDF chosen in a save dialog. */
  savePdf(suggestedName: string): Promise<boolean>;

  /**
   * The folder where OneNote on this computer keeps its `.one` backups, with
   * one subfolder per notebook, or null when there is none.
   */
  findOneNoteBackups(): Promise<string | null>;

  /** Shows a folder picker. Resolves null when cancelled. */
  pickFolder(): Promise<string | null>;

  /** Every `.one` and `.onetoc2` file under a folder, paths relative to it. */
  listOneNoteFiles(folder: string): Promise<Array<{ path: string; size: number }>>;

  /** Reads one file found by `listOneNoteFiles`. Read-only. */
  readOneNoteFile(folder: string, path: string): Promise<Uint8Array>;

  /** Calls the listener when a native menu item is chosen. Returns unsubscribe. */
  onMenuCommand(listener: (command: MenuCommand) => void): () => void;
}

/** Commands a native menu can send. The web client runs the same action as its own control. */
export type MenuCommand =
  | 'new-page'
  | 'new-section'
  | 'new-section-group'
  | 'new-notebook'
  | 'import-onenote'
  | 'export'
  | 'save-pdf'
  | 'print'
  | 'undo'
  | 'redo'
  | 'find'
  | 'zoom-in'
  | 'zoom-out'
  | 'zoom-reset'
  | 'deleted-notes'
  | 'settings';

declare global {
  interface Window {
    looseleafShell?: ShellBridge;
  }
}

export function shell(): ShellBridge | null {
  return typeof window !== 'undefined' && window.looseleafShell ? window.looseleafShell : null;
}
