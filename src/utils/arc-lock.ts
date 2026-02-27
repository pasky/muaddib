/**
 * Async per-arc (keyed) lock: serialises calls for the same arc key while allowing
 * different arcs to run concurrently.  Used by ChronicleLifecycle and AutoChronicler.
 */
export class ArcLockManager {
  private readonly queues = new Map<string, Promise<void>>();

  async run<T>(arc: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(arc) ?? Promise.resolve();

    let release: (() => void) | undefined;
    const signal = new Promise<void>((resolve) => {
      release = resolve;
    });

    const queued = previous.then(async () => await signal);
    this.queues.set(arc, queued);

    await previous;

    try {
      return await fn();
    } finally {
      release?.();
      if (this.queues.get(arc) === queued) {
        this.queues.delete(arc);
      }
    }
  }
}
