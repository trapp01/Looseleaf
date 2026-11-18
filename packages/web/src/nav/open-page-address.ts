/**
 * Opens the page a page address names. The address arrives as the URL's
 * `#page=<pageId>` fragment: typed or followed in a browser, or set by the
 * desktop app when the operating system hands it a `looseleaf://` address.
 */
import { useEffect } from 'react';
import { pageIdFromHash } from '@looseleaf/model';
import { searchablePages, type Services } from '../app/services.js';
import { patchUi } from '../app/ui-state.js';

export function useOpenPageAddress({ notebooks, selection, ui }: Services): void {
  useEffect(() => {
    // The page asked for stays wanted until its notebook has loaded or synced far enough to hold it.
    let wanted: string | null = null;
    const open = () => {
      if (wanted === null) return;
      const page = searchablePages(notebooks).find((p) => p.pageId === wanted);
      if (!page) return;
      wanted = null;
      selection.selectPage(page.pageId, page.sectionId, page.notebookId);
      patchUi(ui, { view: 'page', phonePane: 'page' });
    };
    const read = () => {
      const pageId = pageIdFromHash(window.location.hash);
      if (pageId === null) return;
      // The fragment is removed once read, so a reload returns to the page last selected and the same address can be opened twice.
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
      wanted = pageId;
      open();
    };

    let watched: Array<() => void> = [];
    const watch = () => {
      watched.forEach((stop) => stop());
      watched = [...notebooks.docs.get().values()].map((doc) => {
        doc.on('update', open);
        return () => doc.off('update', open);
      });
      open();
    };
    watch();
    const stopDocs = notebooks.docs.subscribe(watch);
    read();
    window.addEventListener('hashchange', read);
    return () => {
      window.removeEventListener('hashchange', read);
      stopDocs();
      watched.forEach((stop) => stop());
    };
  }, [notebooks, selection, ui]);
}
