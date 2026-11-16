/**
 * The listeners for one kind of event. A listener that throws is logged and
 * the rest still run, so a listener cannot fail the work that reported the
 * event.
 */
export class Listeners<T> {
  private readonly listeners = new Set<(value: T) => void>();

  /** Returns unsubscribe. */
  add(listener: (value: T) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(value: T): void {
    for (const listener of this.listeners) {
      try {
        listener(value);
      } catch (error) {
        console.error(`A listener failed on ${String(value)}`, error);
      }
    }
  }

  clear(): void {
    this.listeners.clear();
  }
}
