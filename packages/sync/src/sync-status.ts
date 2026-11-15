/**
 * The status a SyncClient publishes for the UI: connection state, progress,
 * the last error, and what is not yet sent or stored.
 */

export type SyncState =
  /** No server address has been given; the replica works on its own. */
  | 'no-server'
  /** A server is configured but not connected: waiting to retry, or stopped by a bad token. */
  | 'offline'
  /** A socket is opening or waiting for the server's welcome. */
  | 'connecting'
  /** Welcomed; handshakes or blob transfers are still running, or something is not yet sent or stored. */
  | 'syncing'
  /**
   * Every doc has finished its handshake, every blob has been transferred,
   * nothing is unsent or unstored, and live updates flow both ways. Docs that
   * failed in this session are listed in `failedDocs`.
   */
  | 'synced';

export type SyncErrorKind =
  /** The server refused the token. The client stops retrying until `connect` is called again. */
  | 'bad-token'
  /** The server could not be reached or the connection dropped. The client keeps retrying. */
  | 'unreachable'
  /** The server sent something this client cannot read, or refused the protocol version. */
  | 'protocol'
  /** A blob upload or download failed. */
  | 'blob'
  /** The replica store failed a read or write. */
  | 'store';

export interface SyncError {
  kind: SyncErrorKind;
  message: string;
  /** Epoch ms. */
  at: number;
}

export interface SyncStatus {
  state: SyncState;
  /** The configured server address, or null. */
  server: string | null;
  /** Docs handshaken so far in this session, and docs to handshake in total. Both 0 when not welcomed. */
  docsDone: number;
  docsTotal: number;
  /**
   * The most recent error; cleared when a server welcomes the client or the
   * server is changed, except a 'store' error while `unstoredDocs` is above 0.
   */
  lastError: SyncError | null;
  /** Epoch ms the replica was last known in step with the server; kept across restarts. */
  lastSyncedAt: number | null;
  /** When the next reconnect attempt is due (epoch ms), while offline and retrying. */
  nextRetryAt: number | null;
  /** Docs with local changes the server has not been sent. */
  unsentDocs: number;
  /** Blobs stored locally that the server is not known to have. */
  unsentBlobs: number;
  /**
   * Docs holding changes the replica store refused to keep (for example, a
   * full disk). They are retried every few seconds and sent to the server
   * meanwhile; the docs stay in memory until stored.
   */
  unstoredDocs: number;
  /** Docs that could not be synced in this session; each is retried on the next connect. */
  failedDocs: string[];
}

/** True when two statuses would render the same. */
export function sameStatus(a: SyncStatus, b: SyncStatus): boolean {
  return (
    a.state === b.state &&
    a.server === b.server &&
    a.docsDone === b.docsDone &&
    a.docsTotal === b.docsTotal &&
    a.lastError === b.lastError &&
    a.lastSyncedAt === b.lastSyncedAt &&
    a.nextRetryAt === b.nextRetryAt &&
    a.unsentDocs === b.unsentDocs &&
    a.unsentBlobs === b.unsentBlobs &&
    a.unstoredDocs === b.unstoredDocs &&
    a.failedDocs.length === b.failedDocs.length &&
    a.failedDocs.every((docId, index) => docId === b.failedDocs[index])
  );
}
