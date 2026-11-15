/** Settings: connect to a server, change it, disconnect, and the sync details. */
import { useState } from 'react';
import { Dialog } from './controls.js';
import { chooseDeviceOnly } from './connection.js';
import { ServerForm } from './FirstRun.js';
import { useServices } from './services.js';
import { SyncDetails } from '../sync-ui/SyncStatusControl.js';
import { useSyncStatus } from '../sync-ui/use-sync-status.js';

export function Settings({ onClose }: { onClose: () => void }) {
  const { client } = useServices();
  const status = useSyncStatus(client);
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);

  return (
    <Dialog title="Settings" onClose={onClose}>
      <section className="settings-section">
        <h3>Sync</h3>
        {editing ? (
          <ServerForm
            initialAddress={status.server ?? ''}
            submitLabel={status.server ? 'Change server' : 'Connect'}
            onDone={() => setEditing(false)}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <>
            <p className="muted">
              {status.server
                ? `Syncing with ${status.server}.`
                : 'Notes are kept on this device only. Connecting uploads everything already written here.'}
            </p>
            <div className="form-actions start">
              <button className="button primary" onClick={() => setEditing(true)}>
                {status.server ? 'Change server or token' : 'Connect to a server'}
              </button>
              {status.server &&
                (confirming ? (
                  <>
                    <span className="muted">Stop syncing? Notes stay on this device.</span>
                    <button
                      className="button danger"
                      onClick={async () => {
                        await client.disconnect();
                        chooseDeviceOnly(true);
                        setConfirming(false);
                      }}
                    >
                      Disconnect
                    </button>
                  </>
                ) : (
                  <button className="button" onClick={() => setConfirming(true)}>
                    Disconnect
                  </button>
                ))}
            </div>
          </>
        )}
      </section>
      <section className="settings-section">
        <h3>Details</h3>
        <SyncDetails status={status} />
      </section>
    </Dialog>
  );
}
