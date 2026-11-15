/**
 * IPC channel names shared by the preload script and the main process. Each
 * bridge method in `ShellBridge` has one channel; `menuCommand` runs main → page.
 */
export const CHANNELS = {
  saveFile: 'looseleaf:save-file',
  savePdf: 'looseleaf:save-pdf',
  findOneNoteBackups: 'looseleaf:find-onenote-backups',
  pickFolder: 'looseleaf:pick-folder',
  listOneNoteFiles: 'looseleaf:list-onenote-files',
  readOneNoteFile: 'looseleaf:read-onenote-file',
  menuCommand: 'looseleaf:menu-command',
} as const;

export type InvokeChannel = Exclude<(typeof CHANNELS)[keyof typeof CHANNELS], typeof CHANNELS.menuCommand>;
