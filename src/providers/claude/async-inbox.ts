export class AsyncInbox<T> implements AsyncIterable<T>, AsyncIterator<T> {
  readonly #buffer: T[] = [];
  readonly #waiters: Array<(result: IteratorResult<T>) => void> = [];
  #closed = false;

  get bufferedCount(): number {
    return this.#buffer.length;
  }

  push(value: T): void {
    if (this.#closed) {
      throw new Error("Claude input inbox is closed");
    }

    const waiter = this.#waiters.shift();
    if (waiter) {
      waiter({ done: false, value });
      return;
    }
    this.#buffer.push(value);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    while (this.#waiters.length > 0) {
      this.#waiters.shift()?.({ done: true, value: undefined });
    }
  }

  next(): Promise<IteratorResult<T>> {
    const value = this.#buffer.shift();
    if (value !== undefined) {
      return Promise.resolve({ done: false, value });
    }
    if (this.#closed) {
      return Promise.resolve({ done: true, value: undefined });
    }
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return this;
  }
}
