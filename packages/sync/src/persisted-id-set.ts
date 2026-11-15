/**
 * A set of ids kept in one setting as a JSON array, so a count such as
 * "docs not yet sent" survives a restart. Several tabs can share one store:
 * each write applies this tab's additions and removals to the saved set in
 * one atomic step, so one tab does not erase another's entries. Changes apply
 * in memory at once and are written in order; a failed write goes to
 * `onError` and its changes are written with the next one.
 */
import type { SettingsStore } from './replica-store.js';

export class PersistedIdSet {
  private written: Promise<void> = Promise.resolve();
  /** Changes not yet written: id → true for added, false for removed. */
  private readonly changes = new Map<string, boolean>();

  private constructor(
    private readonly store: SettingsStore,
    private readonly key: string,
    private ids: Set<string>,
    private readonly onError: (error: Error) => void,
  ) {}

  /** Reads the set. A value that is not a JSON array of strings is reported and read as empty. */
  static async load(store: SettingsStore, key: string, onError: (error: Error) => void): Promise<PersistedIdSet> {
    const ids = parseIds(key, await store.getSetting(key), onError);
    return new PersistedIdSet(store, key, new Set(ids), onError);
  }

  get size(): number {
    return this.ids.size;
  }

  /** Returns true when the id was not in the set. */
  add(id: string): boolean {
    if (this.ids.has(id)) return false;
    this.ids.add(id);
    this.change(id, true);
    return true;
  }

  /** Returns true when the id was in the set. */
  delete(id: string): boolean {
    if (!this.ids.delete(id)) return false;
    this.change(id, false);
    return true;
  }

  /** Makes the set exactly `ids`, for this tab and in the saved setting. */
  replace(ids: Iterable<string>): void {
    const next = new Set(ids);
    for (const id of this.ids) if (!next.has(id)) this.change(id, false);
    for (const id of next) if (!this.ids.has(id)) this.change(id, true);
    this.ids = next;
  }

  /** Resolves once every write queued so far has finished. */
  flushed(): Promise<void> {
    return this.written;
  }

  private change(id: string, added: boolean): void {
    this.changes.set(id, added);
    this.written = this.written.then(() => this.write());
  }

  private async write(): Promise<void> {
    if (this.changes.size === 0) return;
    const pending = new Map(this.changes);
    this.changes.clear();
    try {
      await this.store.updateSetting(this.key, (value) => {
        const saved = new Set(parseIds(this.key, value, this.onError));
        for (const [id, added] of pending) {
          if (added) saved.add(id);
          else saved.delete(id);
        }
        return saved.size === 0 ? null : JSON.stringify([...saved]);
      });
    } catch (error) {
      for (const [id, added] of pending) if (!this.changes.has(id)) this.changes.set(id, added);
      this.onError(new Error(`Could not save setting "${this.key}": ${String(error)}`));
    }
  }
}

function parseIds(key: string, saved: string | null, onError: (error: Error) => void): string[] {
  if (saved === null) return [];
  try {
    const parsed: unknown = JSON.parse(saved);
    if (!Array.isArray(parsed) || !parsed.every((id) => typeof id === 'string')) throw new Error('not a list of ids');
    return parsed;
  } catch (error) {
    onError(new Error(`Setting "${key}" holds ${saved.slice(0, 80)}, which is ${String(error)}; reading it as empty`));
    return [];
  }
}
