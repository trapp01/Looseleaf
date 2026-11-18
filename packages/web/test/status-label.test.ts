import { describe, expect, it } from 'vitest';
import type { SyncStatus } from '@looseleaf/sync';
import { describeStatus, describeTime } from '../src/sync-ui/status-label.js';

const base: SyncStatus = {
  state: 'synced',
  server: 'http://nas:8421',
  docsDone: 0,
  docsTotal: 0,
  lastError: null,
  lastSyncedAt: null,
  nextRetryAt: null,
  unsentDocs: 0,
  unsentBlobs: 0,
  unstoredDocs: 0,
  failedDocs: [],
};

describe('describeStatus', () => {
  it('gives each state a short label', () => {
    expect(describeStatus(base).label).toBe('Synced');
    expect(describeStatus({ ...base, state: 'syncing', docsDone: 12, docsTotal: 340 }).label).toBe('Syncing 12 of 340');
    expect(describeStatus({ ...base, state: 'no-server', server: null }).label).toBe('On this device');
    expect(describeStatus({ ...base, state: 'offline' }).label).toBe('Offline — changes are saved on this device');
    expect(describeStatus({ ...base, state: 'offline', lastError: { kind: 'bad-token', message: 'x', at: 0 } }).label).toBe('Wrong access token');
  });

  it('tells an app older than the server to update, while offline and between retries', () => {
    const outdated = { kind: 'outdated' as const, message: 'x', at: 0 };
    for (const state of ['offline', 'connecting'] as const) {
      const label = describeStatus({ ...base, state, lastError: outdated });
      expect(label.label).toBe('Update needed');
      expect(label.detail).toMatch(/^This app is older than the server\. Reload the page or restart the app to update\./);
    }
  });

  it('describes the last synced time', () => {
    const now = new Date(2026, 10, 15, 12, 0).getTime();
    expect(describeTime(null, now)).toBe('Never');
    expect(describeTime(now - 10_000, now)).toBe('Just now');
    expect(describeTime(now - 5 * 60_000, now)).toBe('5 minutes ago');
    expect(describeTime(now - 3 * 3_600_000, now)).toMatch(/^Today at /);
  });
});
