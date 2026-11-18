/**
 * The sync status control in the title bar (and the phone's sections pane): a
 * small icon and a short label for the current state. Pressing it opens the
 * details: server, last synced time, items still to send, the last error and
 * "Retry now".
 */
import { useEffect, useRef, useState } from 'react';
import {
  ArrowSyncRegular,
  CloudCheckmarkRegular,
  CloudOffRegular,
  ErrorCircleRegular,
  LaptopRegular,
} from '@fluentui/react-icons';
import type { SyncStatus } from '@looseleaf/sync';
import { Popover } from '../app/controls.js';
import { useServices } from '../app/services.js';
import { patchUi } from '../app/ui-state.js';
import { describeStatus, describeTime, type StatusTone } from './status-label.js';
import { useSyncStatus } from './use-sync-status.js';

const ICONS: Record<StatusTone, typeof CloudCheckmarkRegular> = {
  ok: CloudCheckmarkRegular,
  busy: ArrowSyncRegular,
  offline: CloudOffRegular,
  error: ErrorCircleRegular,
  local: LaptopRegular,
};

export function SyncStatusControl({ compact = false }: { compact?: boolean }) {
  const { client } = useServices();
  const status = useSyncStatus(client);
  const label = describeStatus(status);
  const Icon = ICONS[label.tone];
  const button = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        ref={button}
        className={`sync-status tone-${label.tone} ${compact ? 'is-compact' : ''}`}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={`Sync: ${label.label}`}
        title={label.label}
        data-state={status.state}
      >
        <Icon className={label.tone === 'busy' ? 'spin' : undefined} />
        {!compact && <span className="sync-status-label">{label.label}</span>}
      </button>
      {open && (
        <Popover anchor={button.current} onClose={() => setOpen(false)} align="end" className="sync-details">
          <SyncDetails status={status} onClose={() => setOpen(false)} />
        </Popover>
      )}
    </>
  );
}

export function SyncDetails({ status, onClose }: { status: SyncStatus; onClose?: () => void }) {
  const { client, ui } = useServices();
  const label = describeStatus(status);
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(timer);
  }, []);
  const toSend = status.unsentDocs + status.unsentBlobs;
  return (
    <div className="sync-details-body">
      <p className="sync-details-lead">{label.detail}</p>
      <dl className="details-list">
        <dt>Server</dt>
        <dd>{status.server ?? 'None'}</dd>
        {status.server && (
          <>
            <dt>Last synced</dt>
            <dd>{describeTime(status.lastSyncedAt)}</dd>
          </>
        )}
        <dt>Still to send</dt>
        <dd>{toSend === 0 ? 'Nothing' : `${status.unsentDocs} notes, ${status.unsentBlobs} files`}</dd>
        {status.unstoredDocs > 0 && (
          <>
            <dt>Not saved</dt>
            <dd className="details-error">
              Couldn’t save changes to {status.unstoredDocs === 1 ? '1 page' : `${status.unstoredDocs} pages`} on this device
              {status.lastError?.kind === 'store' ? `: ${status.lastError.message}` : '.'} They stay open and are tried again.
            </dd>
          </>
        )}
        {status.failedDocs.length > 0 && (
          <>
            <dt>Not synced</dt>
            <dd className="details-error">
              {status.failedDocs.length === 1 ? '1 note' : `${status.failedDocs.length} notes`} couldn’t sync this time. They’re tried again on
              the next connection.
            </dd>
          </>
        )}
        {/* An outdated app's error is the detail sentence above. */}
        {status.lastError && status.lastError.kind !== 'outdated' && !(status.unstoredDocs > 0 && status.lastError.kind === 'store') && (
          <>
            <dt>Last error</dt>
            <dd className="details-error">{status.lastError.message}</dd>
          </>
        )}
      </dl>
      <div className="form-actions">
        {onClose && (
          <button
            className="button"
            onClick={() => {
              onClose();
              patchUi(ui, { dialog: { kind: 'settings' } });
            }}
          >
            Settings
          </button>
        )}
        {status.server && (
          <button className="button primary" disabled={status.state !== 'offline'} onClick={() => client.retryNow()}>
            Retry now
          </button>
        )}
      </div>
    </div>
  );
}
