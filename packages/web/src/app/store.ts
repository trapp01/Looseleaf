import { useSyncExternalStore } from 'react';

/**
 * One observable value. React reads it with `useStore`; plain code reads it
 * with `get` and changes it with `set` or `update`. Setting an identical value
 * notifies nobody.
 */
export class Store<T> {
  private readonly listeners = new Set<() => void>();

  constructor(private value: T) {}

  readonly get = (): T => this.value;

  set(next: T): void {
    if (Object.is(next, this.value)) return;
    this.value = next;
    for (const listener of [...this.listeners]) listener();
  }

  update(change: (value: T) => T): void {
    this.set(change(this.value));
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
}

export function useStore<T>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
