/**
 * Import from OneNote. In the desktop shell it finds OneNote's backups on the
 * computer (or takes a chosen folder) and lists the notebooks as checkboxes;
 * in a browser it takes a folder from the picker or a drop of folders or
 * `.one` files. Then it shows progress per section, waits until the device
 * has stored everything, and shows a report.
 */
import { useRef, useState } from 'react';
import { ArrowImportRegular, CheckmarkCircleRegular, FolderOpenRegular, WarningRegular } from '@fluentui/react-icons';
import { Dialog } from '../app/controls.js';
import { guardLeaving } from '../app/leave-guard.js';
import { useServices } from '../app/services.js';
import { patchUi } from '../app/ui-state.js';
import { shell } from '../shell-bridge.js';
import { clientDocSink, importNotebooks, parseInWorker, plainError, type ImportReport, type ImportSource } from './import-run.js';
import { browserNotebooks, droppedFiles, shellBackupNotebooks, shellFolderNotebook } from './sources.js';

type Step =
  | { kind: 'choose'; message?: string }
  | { kind: 'pick'; sources: ImportSource[]; chosen: Set<string> }
  | { kind: 'running'; sections: Array<{ notebook: string; path: string }>; writing: string | null }
  | { kind: 'saving' }
  | { kind: 'done'; report: ImportReport }
  | { kind: 'failed'; messages: string[] };

const LOOSE_NAME = 'Imported notes';

export function ImportDialog({ onClose }: { onClose: () => void }) {
  const services = useServices();
  const bridge = shell();
  const [step, setStep] = useState<Step>({ kind: 'choose' });
  const [dragging, setDragging] = useState(false);
  const folderInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const run = async (sources: ImportSource[]) => {
    const usable = sources.filter((s) => s.files.length > 0);
    if (usable.length === 0) return setStep({ kind: 'choose', message: 'No OneNote section files (.one) were found there.' });
    setStep({ kind: 'running', sections: [], writing: null });
    const sink = clientDocSink(services.client);
    const stopGuarding = guardLeaving(() => true);
    try {
      const report = await importNotebooks(usable, sink, parseInWorker, (p) =>
        setStep((s) => {
          if (p.kind === 'saving') return { kind: 'saving' };
          if (s.kind !== 'running') return s;
          if (p.kind === 'reading') return { ...s, sections: [...s.sections, { notebook: p.notebook, path: p.path }], writing: null };
          return { ...s, writing: `Adding pages to ${p.notebook}: ${p.pagesDone + 1} of ${p.pagesTotal}` };
        }),
      );
      if (report.imported.length > 0) setStep({ kind: 'done', report });
      else setStep({ kind: 'failed', messages: report.failed.map((f) => (usable.length > 1 ? `${f.notebook}: ${f.message}` : f.message)) });
    } catch (error) {
      setStep({ kind: 'failed', messages: [plainError(error as Error)] });
    } finally {
      sink.close();
      stopGuarding();
    }
  };

  const findBackups = async () => {
    if (!bridge) return;
    const root = await bridge.findOneNoteBackups();
    if (!root) return setStep({ kind: 'choose', message: 'No OneNote backups were found on this computer. Choose a folder instead.' });
    const sources = await shellBackupNotebooks(bridge, root);
    if (sources.length === 0) return setStep({ kind: 'choose', message: 'OneNote’s backup folder has no notebooks in it.' });
    setStep({ kind: 'pick', sources, chosen: new Set(sources.map((s) => s.notebookName)) });
  };

  const chooseFolder = async () => {
    if (bridge) {
      const folder = await bridge.pickFolder();
      if (folder) await run([await shellFolderNotebook(bridge, folder)]);
      return;
    }
    folderInput.current?.click();
  };

  const openFirst = (report: ImportReport) => {
    const id = report.notebookIds[0];
    if (id) services.selection.selectNotebook(id);
    patchUi(services.ui, { dialog: null, view: 'page', railPanel: 'notebooks', phonePane: 'sections' });
  };

  return (
    <Dialog title="Import from OneNote" onClose={onClose} wide className="import-dialog">
      {step.kind === 'choose' && (
        <div
          className={`drop-zone ${dragging ? 'is-dragging' : ''}`}
          data-testid="import-drop"
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={async (e) => {
            e.preventDefault();
            setDragging(false);
            void run(browserNotebooks(await droppedFiles(e.dataTransfer), LOOSE_NAME));
          }}
        >
          <ArrowImportRegular className="drop-icon" />
          <p className="drop-lead">
            {bridge ? 'Import notebooks from OneNote’s backups or from a folder of .one files.' : 'Drop a notebook folder or .one files here.'}
          </p>
          <div className="form-actions center">
            {bridge && (
              <button className="button primary" onClick={findBackups}>
                Import from OneNote on this computer
              </button>
            )}
            <button className={`button ${bridge ? '' : 'primary'}`} onClick={chooseFolder}>
              <FolderOpenRegular /> Choose a folder…
            </button>
            {!bridge && (
              <button className="button" onClick={() => fileInput.current?.click()}>
                Choose .one files…
              </button>
            )}
          </div>
          {step.message && (
            <p className="form-error" role="alert">
              {step.message}
            </p>
          )}
          <p className="muted small">Each import adds a new notebook. Importing the same notebook twice makes a second copy.</p>
          <input
            ref={folderInput}
            type="file"
            hidden
            multiple
            data-testid="import-folder-input"
            {...{ webkitdirectory: '', directory: '' }}
            onChange={(e) => {
              const files = [...(e.target.files ?? [])];
              e.target.value = '';
              void run(browserNotebooks(files.map((file) => ({ file, path: file.webkitRelativePath || file.name })), LOOSE_NAME));
            }}
          />
          <input
            ref={fileInput}
            type="file"
            hidden
            multiple
            accept=".one"
            data-testid="import-file-input"
            onChange={(e) => {
              const files = [...(e.target.files ?? [])];
              e.target.value = '';
              void run(browserNotebooks(files.map((file) => ({ file, path: file.name })), LOOSE_NAME));
            }}
          />
        </div>
      )}

      {step.kind === 'pick' && (
        <div className="stack">
          <p>Notebooks found on this computer:</p>
          <div className="choice-list">
            {step.sources.map((s) => (
              <label key={s.notebookName} className="choice-row">
                <input
                  type="checkbox"
                  checked={step.chosen.has(s.notebookName)}
                  onChange={(e) => {
                    const chosen = new Set(step.chosen);
                    if (e.target.checked) chosen.add(s.notebookName);
                    else chosen.delete(s.notebookName);
                    setStep({ ...step, chosen });
                  }}
                />
                <span>{s.notebookName}</span>
                <span className="muted">{s.files.length === 1 ? '1 section file' : `${s.files.length} section files`}</span>
              </label>
            ))}
          </div>
          <p className="muted small">Importing the same notebook twice makes a second copy.</p>
          <div className="form-actions">
            <button className="button" onClick={() => setStep({ kind: 'choose' })}>
              Back
            </button>
            <button
              className="button primary"
              disabled={step.chosen.size === 0}
              onClick={() => void run(step.sources.filter((s) => step.chosen.has(s.notebookName)))}
            >
              Import {step.chosen.size === 1 ? '1 notebook' : `${step.chosen.size} notebooks`}
            </button>
          </div>
        </div>
      )}

      {step.kind === 'running' && (
        <div className="stack" aria-live="polite">
          <p className="import-status">{step.writing ?? 'Reading sections…'}</p>
          <ul className="import-progress">
            {step.sections.map((s, i) => {
              const current = i === step.sections.length - 1 && !step.writing;
              return (
                <li key={`${s.notebook}/${s.path}`} className={current ? 'is-current' : 'is-done'}>
                  {current ? <span className="spinner" /> : <CheckmarkCircleRegular />}
                  <span className="row-label">{s.path.replace(/\.one$/i, '')}</span>
                  <span className="muted">{s.notebook}</span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {step.kind === 'saving' && (
        <div className="stack" aria-live="polite">
          <p className="import-status">
            <span className="spinner" /> Saving to this device…
          </p>
        </div>
      )}

      {step.kind === 'done' && <ImportReportView report={step.report} onOpen={() => openFirst(step.report)} />}

      {step.kind === 'failed' && (
        <div className="stack">
          <div role="alert">
            {step.messages.map((message, i) => (
              <p key={i} className="form-error">
                {message}
              </p>
            ))}
          </div>
          <div className="form-actions">
            <button className="button" onClick={() => setStep({ kind: 'choose' })}>
              Try again
            </button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

function ImportReportView({ report, onOpen }: { report: ImportReport; onOpen: () => void }) {
  const n = (count: number, one: string, many: string) => `${count.toLocaleString()} ${count === 1 ? one : many}`;
  return (
    <div className="stack import-report" data-testid="import-report">
      <h3>Import finished</h3>
      <dl className="report-totals">
        <div>
          <dt>Notebooks</dt>
          <dd>{report.imported.length}</dd>
        </div>
        <div>
          <dt>Sections</dt>
          <dd>{report.sections}</dd>
        </div>
        <div>
          <dt>Pages</dt>
          <dd>{report.pages}</dd>
        </div>
        <div>
          <dt>Pictures and files</dt>
          <dd>{report.pictures}</dd>
        </div>
      </dl>
      {report.failed.length > 0 && (
        <>
          <p>Imported: {report.imported.join(' · ')}</p>
          <h4>
            <WarningRegular /> Not imported
          </h4>
          <ul className="warning-list is-failed">
            {report.failed.map((f, i) => (
              <li key={i}>
                <strong>{f.notebook}</strong>
                <span>{f.message}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {report.warnings.length > 0 ? (
        <>
          <h4>
            <WarningRegular /> Things that didn’t come across
          </h4>
          <ul className="warning-list">
            {report.warnings.map((w) => (
              <li key={w.message}>
                <span className="warning-count">{n(w.count, 'time', 'times')}</span>
                <span>{w.message}</span>
                {w.places.length > 0 && <span className="muted small">{w.places.join(' · ')}</span>}
              </li>
            ))}
          </ul>
        </>
      ) : (
        report.failed.length === 0 && <p className="muted">Everything came across.</p>
      )}
      <div className="form-actions">
        <button className="button primary" onClick={onOpen}>
          Open notebook
        </button>
      </div>
    </div>
  );
}
