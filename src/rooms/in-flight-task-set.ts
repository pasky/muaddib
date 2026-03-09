export class InFlightTaskSet {
  private readonly tasks = new Set<Promise<unknown>>();

  add(task: Promise<unknown>): void {
    const trackedTask = task.finally(() => {
      this.tasks.delete(trackedTask);
    });

    this.tasks.add(trackedTask);
  }

  async waitForAll(): Promise<void> {
    if (this.tasks.size === 0) {
      return;
    }

    await Promise.allSettled([...this.tasks]);
  }
}
