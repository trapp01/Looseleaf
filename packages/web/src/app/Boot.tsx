/**
 * Decides between the first-run screens and the app. A device that already
 * has a server, or that chose to keep notes on this device only, goes
 * straight to the app; otherwise first run asks how to sync.
 */
import { useEffect, useState } from 'react';
import { AppShell } from './AppShell.js';
import { detectHostServer, deviceOnlyChosen } from './connection.js';
import { FirstRun } from './FirstRun.js';
import { useServices } from './services.js';
import { useSyncStatus } from '../sync-ui/use-sync-status.js';

export function Boot({ persistent }: { persistent: boolean }) {
  const { client } = useServices();
  const status = useSyncStatus(client);
  const configured = status.server !== null || deviceOnlyChosen();
  const [phase, setPhase] = useState<'checking' | 'first-run' | 'app'>(configured ? 'app' : 'checking');
  const [host, setHost] = useState<string | null>(null);

  useEffect(() => {
    if (phase !== 'checking') return;
    let cancelled = false;
    void detectHostServer().then((address) => {
      if (cancelled) return;
      setHost(address);
      setPhase('first-run');
    });
    return () => {
      cancelled = true;
    };
  }, [phase]);

  if (phase === 'checking') return <div className="boot-blank" aria-busy="true" />;
  if (phase === 'first-run') return <FirstRun host={host} onDone={() => setPhase('app')} />;
  return <AppShell persistent={persistent} />;
}
