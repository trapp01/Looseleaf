/**
 * Asks the browser to confirm before the tab closes or reloads while work
 * would be lost: changes the device has not stored yet, or an import in
 * progress. One `beforeunload` listener checks every registered condition.
 */

const conditions = new Set<() => boolean>();

function onBeforeUnload(event: BeforeUnloadEvent): void {
  for (const busy of conditions) {
    if (!busy()) continue;
    event.preventDefault();
    // Older Chromium shows the prompt only when returnValue is set.
    event.returnValue = '';
    return;
  }
}

/** Confirms leaving whenever `busy()` is true. Returns the function that stops guarding. */
export function guardLeaving(busy: () => boolean): () => void {
  if (conditions.size === 0) window.addEventListener('beforeunload', onBeforeUnload);
  conditions.add(busy);
  return () => {
    if (!conditions.delete(busy)) return;
    if (conditions.size === 0) window.removeEventListener('beforeunload', onBeforeUnload);
  };
}
