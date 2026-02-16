export class AsyncQueue<T> {
  private readonly items: T[] = [];
  private readonly waiters: Array<(value: T) => void> = [];

  /** Discard all queued items and cancel pending waiters (resolving them with the given sentinel). */
  drain(sentinel: T): void {
    this.items.length = 0;
    for (const waiter of this.waiters.splice(0)) {
      waiter(sentinel);
    }
  }

  push(item: T): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(item);
      return;
    }
    this.items.push(item);
  }

  async shift(): Promise<T> {
    if (this.items.length > 0) {
      return this.items.shift() as T;
    }

    return await new Promise<T>((resolve) => {
      this.waiters.push(resolve);
    });
  }
}
