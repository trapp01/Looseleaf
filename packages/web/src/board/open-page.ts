/**
 * Where a page opens from the board's parts (a card front, an Inbox line's
 * page, a card link): beside the board while the board view shows and the
 * page is in its notebook, otherwise in the notebook view, which also
 * switches the page shown when the board is beside it.
 */
import { livePages } from '@looseleaf/model';
import { searchablePages, type Services } from '../app/services.js';
import { patchUi } from '../app/ui-state.js';

export function openPage(services: Services, pageId: string): void {
  const { ui, selection, notebooks, boards, toasts } = services;
  const current = boards.current.get();
  if (ui.get().view === 'board' && current && livePages(current.notebookDoc).has(pageId)) {
    patchUi(ui, { boardPage: pageId });
    return;
  }
  const page = searchablePages(notebooks).find((candidate) => candidate.pageId === pageId);
  if (!page) {
    toasts.show('That page is not on this device. It may be deleted or in a notebook that has not synced yet.');
    return;
  }
  selection.selectPage(page.pageId, page.sectionId, page.notebookId);
  patchUi(ui, { view: 'page', boardPage: null, phonePane: 'page' });
}

/** The page the board shows as open: the one beside it in the board view, else the notebook view's page. */
export function openPageId(view: string, boardPage: string | null, selectedPage: string | null): string | null {
  return view === 'board' ? boardPage : selectedPage;
}
