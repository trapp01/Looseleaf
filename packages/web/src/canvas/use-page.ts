import type { PageSession } from './page-session.js';
import { useServices } from '../app/services.js';
import { Store, useStore } from '../app/store.js';

const NO_HISTORY = new Store(0);

/** The open page's session, re-rendering when it changes or its undo history moves. */
export function usePageHistory(): PageSession | null {
  const { page } = useServices();
  const session = useStore(page);
  useStore(session?.history ?? NO_HISTORY);
  return session;
}
