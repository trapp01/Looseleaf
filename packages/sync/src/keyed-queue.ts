/**
 * Runs async tasks one at a time per key, in the order they were queued.
 * Tasks under different keys run concurrently. A failed task rejects only its
 * own promise; the tasks queued after it still run.
 */
export class KeyedQueue {
  private readonly tails = new Map<string, Promise<void>>();

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.then(task);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }

  /** True while a task for the key is queued or running. */
  busy(key: string): boolean {
    return this.tails.has(key);
  }

  /** Resolves once every task queued so far, under any key, has settled. */
  async drain(): Promise<void> {
    while (this.tails.size > 0) {
      await Promise.all(this.tails.values());
    }
  }
}
