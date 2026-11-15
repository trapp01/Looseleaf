/**
 * The first-run screens. Served by a server, only the access token is asked
 * for. Elsewhere (desktop shell, a plain dev server) the person connects to a
 * server or keeps notes on this device only; both can be changed in Settings.
 */
import { useState, type FormEvent } from 'react';
import { checkServer, chooseDeviceOnly } from './connection.js';
import { useServices } from './services.js';
import { LogoMark } from './LogoMark.js';

export function FirstRun({ host, onDone }: { host: string | null; onDone: () => void }) {
  return (
    <div className="first-run">
      <div className="first-run-card">
        <LogoMark size={48} />
        <h1>Welcome to Looseleaf</h1>
        {host ? <TokenForm address={host} onDone={onDone} /> : <ChooseSync onDone={onDone} />}
      </div>
    </div>
  );
}

function TokenForm({ address, onDone }: { address: string; onDone: () => void }) {
  return (
    <>
      <p className="first-run-lead">Enter the access token for this server.</p>
      <ServerForm fixedAddress={address} onDone={onDone} submitLabel="Start syncing" />
      <p className="first-run-hint">
        The token is in the file named <code>token</code> in the server’s data folder, or in its <code>LOOSELEAF_TOKEN</code>{' '}
        setting.
      </p>
    </>
  );
}

function ChooseSync({ onDone }: { onDone: () => void }) {
  const [connecting, setConnecting] = useState(false);
  if (connecting) {
    return (
      <>
        <p className="first-run-lead">Connect to your Looseleaf server.</p>
        <ServerForm onDone={onDone} submitLabel="Connect" onCancel={() => setConnecting(false)} />
      </>
    );
  }
  return (
    <>
      <p className="first-run-lead">Where should your notes sync?</p>
      <div className="first-run-choices">
        <button className="choice" onClick={() => setConnecting(true)} autoFocus>
          <strong>Connect to a server</strong>
          <span>Sync with the other devices that use your server.</span>
        </button>
        <button
          className="choice"
          onClick={() => {
            chooseDeviceOnly(true);
            onDone();
          }}
        >
          <strong>Keep notes on this device only</strong>
          <span>You can connect to a server later in Settings.</span>
        </button>
      </div>
    </>
  );
}

/** Address (unless fixed) and token, checked against the server before the client connects. */
export function ServerForm({
  fixedAddress,
  initialAddress = '',
  submitLabel,
  onDone,
  onCancel,
}: {
  fixedAddress?: string;
  initialAddress?: string;
  submitLabel: string;
  onDone: () => void;
  onCancel?: () => void;
}) {
  const { client } = useServices();
  const [address, setAddress] = useState(fixedAddress ?? initialAddress);
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const url = await checkServer(address, token);
      await client.connect({ url, token });
      chooseDeviceOnly(false);
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="server-form" onSubmit={submit}>
      {fixedAddress === undefined && (
        <label className="field">
          <span>Server address</span>
          <input
            type="url"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="http://nas:8421"
            autoFocus
            required
            spellCheck={false}
            autoCapitalize="off"
          />
        </label>
      )}
      <label className="field">
        <span>Access token</span>
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          autoFocus={fixedAddress !== undefined}
          required
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
        />
      </label>
      <p className="form-error" role="alert">
        {error ?? ''}
      </p>
      <div className="form-actions">
        {onCancel && (
          <button type="button" className="button" onClick={onCancel}>
            Back
          </button>
        )}
        <button type="submit" className="button primary" disabled={busy}>
          {busy ? 'Checking…' : submitLabel}
        </button>
      </div>
    </form>
  );
}
