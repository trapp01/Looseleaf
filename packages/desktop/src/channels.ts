/**
 * IPC channel names shared by the preload script and the main process. Each
 * bridge method in `ShellBridge` has one channel, except `onUpdateReady`,
 * which asks over `updateReady` and then listens on `updateReadyEvent`.
 * `menuCommand` and `updateReadyEvent` run main → page.
 */
export const CHANNELS = {
  saveFile: 'looseleaf:save-file',
  savePdf: 'looseleaf:save-pdf',
  findOneNoteBackups: 'looseleaf:find-onenote-backups',
  pickFolder: 'looseleaf:pick-folder',
  listOneNoteFiles: 'looseleaf:list-onenote-files',
  readOneNoteFile: 'looseleaf:read-onenote-file',
  chooseMirrorFolder: 'looseleaf:choose-mirror-folder',
  mirrorFolder: 'looseleaf:mirror-folder',
  stopMirroring: 'looseleaf:stop-mirroring',
  readMirrorManifest: 'looseleaf:read-mirror-manifest',
  applyMirrorBatch: 'looseleaf:apply-mirror-batch',
  updateReady: 'looseleaf:update-ready',
  restartToUpdate: 'looseleaf:restart-to-update',
  menuCommand: 'looseleaf:menu-command',
  updateReadyEvent: 'looseleaf:update-ready-event',
} as const;

export type InvokeChannel = Exclude<
  (typeof CHANNELS)[keyof typeof CHANNELS],
  typeof CHANNELS.menuCommand | typeof CHANNELS.updateReadyEvent
>;
