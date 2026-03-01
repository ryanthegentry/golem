/** Fixed-size event buffer (FIFO eviction when capacity exceeded). */
export class EventLog<T> {
  private events: T[] = [];

  constructor(private readonly maxSize = 100) {}

  push(event: T): void {
    this.events.push(event);
    if (this.events.length > this.maxSize) {
      this.events.shift();
    }
  }

  getAll(): T[] {
    return [...this.events];
  }

  getLast(): T | undefined {
    return this.events[this.events.length - 1];
  }
}
