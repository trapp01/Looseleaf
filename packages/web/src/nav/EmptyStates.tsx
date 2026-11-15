/** What shows when there is nothing to show yet: an empty library, a notebook with no sections, a section with no pages. */
import { useServices } from '../app/services.js';
import { LogoMark } from '../app/LogoMark.js';
import { useSyncStatus } from '../sync-ui/use-sync-status.js';

export function EmptyLibrary() {
  const { commands, client } = useServices();
  const status = useSyncStatus(client);
  const fetching = status.state === 'connecting' || status.state === 'syncing';
  return (
    <div className="empty-state is-full">
      <LogoMark size={56} />
      {fetching ? (
        <>
          <h2>Getting your notebooks…</h2>
          <p className="muted">They appear here as soon as they arrive from the server.</p>
        </>
      ) : (
        <>
          <h2>No notebooks yet</h2>
          <p className="muted">Start a notebook, or bring your notes over from OneNote.</p>
          <div className="form-actions">
            <button className="button" onClick={() => commands.run('import-onenote')}>
              Import from OneNote
            </button>
            <button className="button primary" onClick={() => commands.run('new-notebook')} autoFocus>
              New notebook
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export function EmptySection({ hasSections }: { hasSections: boolean }) {
  const { commands } = useServices();
  return (
    <div className="empty-state">
      {hasSections ? (
        <>
          <h2>This section has no pages</h2>
          <button className="button primary" onClick={() => commands.run('new-page')}>
            Add page
          </button>
        </>
      ) : (
        <>
          <h2>This notebook has no sections</h2>
          <button className="button primary" onClick={() => commands.run('new-section')}>
            Add section
          </button>
        </>
      )}
    </div>
  );
}
