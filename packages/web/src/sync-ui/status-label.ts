/**
 * What the sync status control says for each SyncStatus: a short label, a
 * tone for the icon, and the longer sentence the details popover leads with.
 */
import type { SyncStatus } from '@looseleaf/sync';

export type StatusTone = 'ok' | 'busy' | 'offline' | 'error' | 'local';

export interface StatusLabel {
  tone: StatusTone;
  label: string;
  detail: string;
}

export function describeStatus(status: SyncStatus): StatusLabel {
  const error = status.lastError;
  // An outdated app is refused at every retry, so the brief reconnects between them say nothing new.
  if (error?.kind === 'outdated' && (status.state === 'offline' || status.state === 'connecting')) {
    return {
      tone: 'error',
      label: 'Update needed',
      detail: 'This app is older than the server. Reload the page or restart the app to update. Changes are saved on this device and sync after the update.',
    };
  }
  switch (status.state) {
    case 'no-server':
      return { tone: 'local', label: 'On this device', detail: 'Notes are kept on this device only.' };
    case 'connecting':
      return { tone: 'busy', label: 'Connecting…', detail: `Connecting to ${status.server}.` };
    case 'syncing':
      return {
        tone: 'busy',
        label: status.docsTotal > 0 ? `Syncing ${status.docsDone} of ${status.docsTotal}` : 'Syncing…',
        detail: 'Bringing this device and the server in step.',
      };
    case 'synced':
      return { tone: 'ok', label: 'Synced', detail: 'Everything is in step with the server.' };
    case 'offline':
      if (error?.kind === 'bad-token') {
        return {
          tone: 'error',
          label: 'Wrong access token',
          detail: 'The server refused the access token. Enter the current one in Settings.',
        };
      }
      if (error?.kind === 'protocol') {
        return { tone: 'error', label: 'Can’t sync', detail: 'The server and this app could not agree on how to sync.' };
      }
      return {
        tone: 'offline',
        label: 'Offline — changes are saved on this device',
        detail: 'The server can’t be reached. Changes are saved on this device and sync when it’s back.',
      };
  }
}

/** "just now", "5 minutes ago", "yesterday at 14:02" or a date, for the last synced time. */
export function describeTime(at: number | null, now = Date.now()): string {
  if (at === null) return 'Never';
  const seconds = Math.round((now - at) / 1000);
  if (seconds < 45) return 'Just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return minutes === 1 ? '1 minute ago' : `${minutes} minutes ago`;
  const date = new Date(at);
  const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const today = new Date(now);
  if (date.toDateString() === today.toDateString()) return `Today at ${time}`;
  const yesterday = new Date(now - 86_400_000);
  if (date.toDateString() === yesterday.toDateString()) return `Yesterday at ${time}`;
  return `${date.toLocaleDateString()} at ${time}`;
}
