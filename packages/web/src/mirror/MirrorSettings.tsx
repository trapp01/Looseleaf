/** The Mirror folder row in Settings: the folder, the mirror's status, and choosing, changing or stopping it. */
import { useStore } from '../app/store.js';
import type { MirrorRunner, MirrorState } from './mirror-runner.js';

const STATUS_LABELS: Record<Exclude<MirrorState['status'], 'failed'>, string> = {
  'up-to-date': 'Up to date',
  writing: 'Writing…',
  'not-empty': 'Choose an empty folder, or one that already holds a Looseleaf mirror.',
};

export function MirrorSettings({ mirror }: { mirror: MirrorRunner }) {
  const state = useStore(mirror.state);
  const choose = () => mirror.chooseFolder().catch((error: unknown) => console.error('Could not choose a mirror folder', error));
  const stop = () => mirror.stop().catch((error: unknown) => console.error('Could not stop mirroring', error));
  const problem = state.status === 'failed' || state.status === 'not-empty';
  const status =
    state.status === 'failed' ? `Could not write to this folder: ${state.error ?? 'unknown error'}` : STATUS_LABELS[state.status];
  const statusLine = (
    <p className={problem ? 'form-error' : 'muted small'} role={problem ? 'alert' : 'status'}>
      {status}
    </p>
  );

  return (
    <section className="settings-section">
      <h3>Mirror folder</h3>
      <p className="muted">
        Keeps a copy of every page as a Markdown file in a folder on this computer. The files are rewritten when a page
        changes; edits made to them are not read back.
      </p>
      {state.folder === null ? (
        <>
          {state.status === 'not-empty' && statusLine}
          <div className="form-actions start">
            <button className="button" onClick={choose}>
              Choose folder…
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="mirror-folder-path">{state.folder}</p>
          {statusLine}
          <div className="form-actions start">
            <button className="button" onClick={choose}>
              Change…
            </button>
            <button className="button" onClick={stop}>
              Stop mirroring
            </button>
          </div>
        </>
      )}
    </section>
  );
}
