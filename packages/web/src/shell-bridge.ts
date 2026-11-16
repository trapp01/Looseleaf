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

  /**
   * Shows a folder picker and makes the chosen folder the mirror folder,
   * remembered across launches. A folder is accepted when it is empty (names
   * starting with `.` aside) or already holds a mirror manifest. Cancelling
   * or a refused folder changes nothing.
   */
  chooseMirrorFolder(): Promise<MirrorFolderChoice>;

  /** The mirror folder's path, or null when none is chosen. */
  mirrorFolder(): Promise<string | null>;

  /** Forgets the mirror folder. Files already written stay. */
  stopMirroring(): Promise<void>;

  /**
   * The mirror manifest in the mirror folder, serialized, or null when it has
   * none or it does not parse. Rejects when no folder is chosen or it is gone.
   */
  readMirrorManifest(): Promise<Uint8Array | null>;

  /**
   * Applies one batch of a mirror plan to the mirror folder: removals, then
   * assets, then pages, then the manifest. Rejects when no folder is chosen,
   * the folder is gone, or a write fails; paths outside the folder and
   * removals the manifest on disk does not list come back as refused.
   */
  applyMirrorBatch(batch: MirrorBatch): Promise<MirrorBatchResult>;

  /** Calls the listener when a native menu item is chosen. Returns unsubscribe. */
  onMenuCommand(listener: (command: MenuCommand) => void): () => void;
}

/** What became of a mirror folder choice. `not-empty` is a folder that holds files other than a mirror's. */
export type MirrorFolderChoice =
  | { status: 'chosen'; folder: string }
  | { status: 'cancelled' }
  | { status: 'not-empty'; folder: string };

/** Part of a mirror plan, sent to the shell in one call. Paths are relative to the mirror folder, with `/` between segments. */
export interface MirrorBatch {
  removals: string[];
  /** Asset files with the bytes of the blob named `hash`. */
  assets: Array<{ path: string; hash: string; bytes: Uint8Array }>;
  pages: Array<{ path: string; bytes: Uint8Array }>;
  /** The serialized mirror manifest that describes the folder once this batch is applied. */
  manifest: Uint8Array;
}

export interface MirrorBatchResult {
  written: number;
  removed: number;
  /** Batch paths the shell left alone, each with the reason. */
  refused: Array<{ path: string; reason: string }>;
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
