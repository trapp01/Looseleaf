import { useSyncExternalStore } from 'react';
import type { SyncClient, SyncStatus } from '@looseleaf/sync';

/** The sync client's status, re-rendering on every change. */
export function useSyncStatus(client: SyncClient): SyncStatus {
  return useSyncExternalStore(
    (notify) => client.onStatus(notify),
    () => client.status,
  );
}
