/** Settings: your name (the actor on board changes), connect to a server, change it, disconnect, the sync details, and the desktop app's mirror folder. */
import { useState, type FormEvent } from 'react';
import { Dialog } from './controls.js';
import { chooseDeviceOnly } from './connection.js';
import { ServerForm } from './FirstRun.js';
import { useServices } from './services.js';
import { MirrorSettings } from '../mirror/MirrorSettings.js';
import { SyncDetails } from '../sync-ui/SyncStatusControl.js';
import { useSyncStatus } from '../sync-ui/use-sync-status.js';

export function Settings({ onClose }: { onClose: () => void }) {
  const { client, mirror } = useServices();
  const status = useSyncStatus(client);
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);

  return (
    <Dialog title="Settings" onClose={onClose}>
      <NameSection />
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
      {mirror && <MirrorSettings mirror={mirror} />}
    </Dialog>
  );
}

/** The name recorded on this device's changes to a board, shown in a card's activity and comments. */
function NameSection() {
  const { actor } = useServices();
  const [name, setName] = useState(actor.get());
  const [saved, setSaved] = useState(false);
  const save = (event: FormEvent) => {
    event.preventDefault();
    actor.set(name.trim());
    setSaved(true);
  };
  return (
    <form className="settings-section stack" onSubmit={save}>
      <label className="field">
        <span>Your name</span>
        <input
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setSaved(false);
          }}
          placeholder="Shown on your comments and card changes"
          maxLength={60}
        />
      </label>
      <div className="form-actions start">
        <button type="submit" className="button" disabled={name.trim() === actor.get()}>
          Save name
        </button>
        {saved && <span className="muted small">Saved</span>}
      </div>
    </form>
  );
}
