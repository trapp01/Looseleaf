/**
 * React access to Yjs: open a doc for as long as a component needs it, and
 * read a value out of a doc or shared type that re-renders whenever that
 * changes, local or remote. Components never observe Yjs themselves.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import * as Y from 'yjs';
import type { SyncClient } from '@looseleaf/sync';

/** The doc for `docId`, or null while it loads or when `docId` is null. Released on unmount or id change. */
export function useOpenDoc(client: SyncClient, docId: string | null): Y.Doc | null {
  const [doc, setDoc] = useState<{ id: string; doc: Y.Doc } | null>(null);
  useEffect(() => {
    if (docId === null) return;
    let cancelled = false;
    let opened = false;
    client.openDoc(docId).then(
      (d) => {
        opened = true;
        if (cancelled) client.releaseDoc(docId);
        else setDoc({ id: docId, doc: d });
      },
      (error: unknown) => console.error(`Could not open ${docId}`, error),
    );
    return () => {
      cancelled = true;
      if (opened) client.releaseDoc(docId);
      setDoc(null);
    };
  }, [client, docId]);
  return doc && doc.id === docId ? doc.doc : null;
}

// Y types are invariant in their event type, so any shared type is accepted here.
type Observable = Y.Doc | Y.AbstractType<any>;

/**
 * `read()` re-run after every change to `target` (every transaction for a doc,
 * deep changes for a shared type, or only its own keys when `shallow`).
 * `read` is re-run when `key` changes too; the value is cached between changes.
 */
export function useYValue<T>(target: Observable | null, read: () => T, key: unknown = null, shallow = false): T {
  const version = useRef(0);
  const cache = useRef<{ version: number; target: Observable | null; key: unknown; value: T } | null>(null);
  const subscribe = useCallback(
    (notify: () => void) => {
      if (!target) return () => undefined;
      const onChange = () => {
        version.current++;
        notify();
      };
      if (target instanceof Y.Doc) {
        target.on('update', onChange);
        return () => target.off('update', onChange);
      }
      if (shallow) {
        target.observe(onChange);
        return () => target.unobserve(onChange);
      }
      target.observeDeep(onChange);
      return () => target.unobserveDeep(onChange);
    },
    [target, shallow],
  );
  const getSnapshot = () => {
    const c = cache.current;
    if (!c || c.version !== version.current || c.target !== target || !Object.is(c.key, key)) {
      const fresh = { version: version.current, target, key, value: read() };
      cache.current = fresh;
      return fresh.value;
    }
    return c.value;
  };
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
