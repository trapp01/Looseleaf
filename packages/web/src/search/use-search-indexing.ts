import { useEffect } from 'react';
import type { Services } from '../app/services.js';

const REFRESH_DELAY_MS = 1500;

/** Keeps the search index in step with every notebook: a refresh shortly after any tree change. */
export function useSearchIndexing({ notebooks, search }: Services): void {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void search.refresh(), REFRESH_DELAY_MS);
    };
    let watched: Array<() => void> = [];
    const watch = () => {
      watched.forEach((stop) => stop());
      watched = [...notebooks.docs.get().values()].map((doc) => {
        doc.on('update', schedule);
        return () => doc.off('update', schedule);
      });
      schedule();
    };
    watch();
    const stopDocs = notebooks.docs.subscribe(watch);
    return () => {
      stopDocs();
      watched.forEach((stop) => stop());
      if (timer) clearTimeout(timer);
    };
  }, [notebooks, search]);
}
