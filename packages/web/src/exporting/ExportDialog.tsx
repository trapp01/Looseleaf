/** The export dialog: choose what (page, section, notebook, everything) and the format, then save. */
import { useState } from 'react';
import { getNode, getNotebook } from '@looseleaf/model';
import { Dialog } from '../app/controls.js';
import { useServices } from '../app/services.js';
import type { Dialog as DialogState } from '../app/ui-state.js';
import { patchUi } from '../app/ui-state.js';
import {
  clientDocSource,
  deliverExport,
  FORMAT_LABELS,
  formatsFor,
  runExport,
  scopesFor,
  type ExportFormatChoice,
  type ExportScopeChoice,
  type ExportTarget,
} from './export-run.js';

const SCOPE_LABELS: Record<ExportScopeChoice, string> = {
  page: 'This page',
  section: 'This section',
  notebook: 'This notebook',
  everything: 'Everything',
};

export function ExportDialog({ request, onClose }: { request: Extract<DialogState, { kind: 'export' }>; onClose: () => void }) {
  const { client, selection, notebooks, library, ui } = useServices();
  const sel = selection.get();
  const notebookId = request.notebookId ?? sel.notebookId;
  const doc = notebooks.get(notebookId);
  const pageId = request.scope === 'section' || request.scope === 'notebook' ? null : (request.pageId ?? sel.pageId);
  const sectionId = request.scope === 'notebook' ? null : (request.sectionId ?? (pageId && doc ? (getNode(doc, pageId)?.parent ?? null) : sel.sectionId));
  const target: ExportTarget = {
    notebookId,
    sectionId,
    pageId,
    notebookName: notebookId ? (getNotebook(library, notebookId)?.name ?? '') : '',
    sectionName: sectionId && doc ? (getNode(doc, sectionId)?.name ?? '') : '',
    pageTitle: pageId && doc ? (getNode(doc, pageId)?.name ?? '') : '',
  };
  const scopes = scopesFor(target);
  const [scope, setScope] = useState<ExportScopeChoice>(request.scope && scopes.includes(request.scope) ? request.scope : scopes[0]!);
  const [format, setFormat] = useState<ExportFormatChoice>('html');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const formats = formatsFor(scope);
  const chosenFormat = formats.includes(format) ? format : 'html';
  const printOtherPage = chosenFormat === 'pdf' && pageId !== sel.pageId;

  const go = async () => {
    setBusy(true);
    setError(null);
    const source = clientDocSource(client);
    try {
      const result = await runExport(source, { scope, format: chosenFormat, target });
      if (result.kind === 'print') {
        // Printing shows the open page, so the page to print is opened first.
        if (pageId && pageId !== sel.pageId) selection.selectPage(pageId, sectionId ?? undefined, notebookId ?? undefined);
        patchUi(ui, { dialog: null, view: 'page' });
        setTimeout(() => void deliverExport(result), 300);
        return;
      }
      await deliverExport(result);
      onClose();
    } catch (e) {
      setError(`The export failed: ${(e as Error).message}`);
    } finally {
      source.close();
      setBusy(false);
    }
  };

  const describe = (s: ExportScopeChoice) =>
    s === 'page' ? target.pageTitle || 'Untitled page' : s === 'section' ? target.sectionName : s === 'notebook' ? target.notebookName : 'All notebooks';

  return (
    <Dialog
      title="Export"
      onClose={onClose}
      footer={
        <>
          <button className="button" onClick={onClose}>
            Cancel
          </button>
          <button className="button primary" onClick={go} disabled={busy} data-testid="export-go">
            {busy ? 'Exporting…' : chosenFormat === 'pdf' ? 'Save as PDF' : 'Export'}
          </button>
        </>
      }
    >
      <fieldset className="field">
        <legend>What to export</legend>
        <div className="choice-list">
          {scopes.map((s) => (
            <label key={s} className="choice-row">
              <input type="radio" name="export-scope" checked={scope === s} onChange={() => setScope(s)} />
              <span>{SCOPE_LABELS[s]}</span>
              <span className="muted">{describe(s)}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset className="field">
        <legend>Format</legend>
        <div className="segmented" role="radiogroup" aria-label="Format">
          {formats.map((f) => (
            <button key={f} role="radio" aria-checked={chosenFormat === f} className={chosenFormat === f ? 'is-selected' : ''} onClick={() => setFormat(f)}>
              {FORMAT_LABELS[f]}
            </button>
          ))}
        </div>
      </fieldset>
      <p className="muted export-note">
        {chosenFormat === 'pdf'
          ? printOtherPage
            ? 'The page opens, then the print dialog lets you save it as a PDF.'
            : 'The print dialog lets you save the page as a PDF.'
          : scope !== 'page'
            ? 'Saved as a zip with one folder per notebook and section.'
            : chosenFormat === 'markdown' || chosenFormat === 'json'
              ? 'A page with pictures or files is saved as a zip that holds them.'
              : 'Saved as one file.'}
      </p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}
