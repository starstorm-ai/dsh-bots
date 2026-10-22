/** Bounded, abortable event queue. Overflow forces a durable reconnect. */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private values: T[] = [];
  private wake?: () => void;
  private ended = false;
  private failure?: Error;
  constructor(private readonly capacity = 1024) {}
  push(value: T): void {
    if (this.ended) return;
    if (this.values.length >= this.capacity) { this.close(new Error('Event consumer is too slow; reconnect from the durable cursor')); return; }
    this.values.push(value); this.wake?.();
  }
  close(error?: Error): void { this.ended = true; this.failure = error; this.wake?.(); }
  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    while (true) {
      if (this.failure) throw this.failure;
      const value = this.values.shift();
      if (value !== undefined) { yield value; continue; }
      if (this.ended) return;
      await new Promise<void>(resolve => { this.wake = resolve; }); this.wake = undefined;
    }
  }
}
