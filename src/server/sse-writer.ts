const DEFAULT_SLICE_BYTES = 64 * 1_024;
const DEFAULT_MAX_QUEUED_BYTES = 4 * 1_024 * 1_024;
const DEFAULT_DRAIN_TIMEOUT_MS = 30_000;

export type SseWriterFailure = "backlog-overflow" | "drain-timeout" | "socket-failure";

export interface SseWritable {
  readonly destroyed: boolean;
  readonly writableEnded: boolean;
  write(chunk: Uint8Array): boolean;
  once(event: "drain" | "close" | "error", listener: (...args: unknown[]) => void): unknown;
  off(event: "drain" | "close" | "error", listener: (...args: unknown[]) => void): unknown;
}

export interface OrderedSseWriterOptions {
  sliceBytes?: number;
  maxQueuedBytes?: number;
  drainTimeoutMs?: number;
  onFailure: (reason: SseWriterFailure) => void;
}

/**
 * Serializes complete SSE events onto one response without treating ordinary
 * stream backpressure as a broken connection. The active event is allowed to
 * finish regardless of its size; only events waiting behind it count toward
 * the bounded backlog.
 */
export class OrderedSseWriter {
  readonly #target: SseWritable;
  readonly #sliceBytes: number;
  readonly #maxQueuedBytes: number;
  readonly #drainTimeoutMs: number;
  readonly #onFailure: (reason: SseWriterFailure) => void;
  readonly #queue: Buffer[] = [];

  #active: Buffer | null = null;
  #activeOffset = 0;
  #queuedBytes = 0;
  #pumping = false;
  #blocked = false;
  #closed = false;

  constructor(target: SseWritable, options: OrderedSseWriterOptions) {
    this.#target = target;
    this.#sliceBytes = options.sliceBytes ?? DEFAULT_SLICE_BYTES;
    this.#maxQueuedBytes = options.maxQueuedBytes ?? DEFAULT_MAX_QUEUED_BYTES;
    this.#drainTimeoutMs = options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
    this.#onFailure = options.onFailure;
    if (!Number.isSafeInteger(this.#sliceBytes) || this.#sliceBytes <= 0) {
      throw new TypeError("sliceBytes must be a positive safe integer");
    }
    if (!Number.isSafeInteger(this.#maxQueuedBytes) || this.#maxQueuedBytes < 0) {
      throw new TypeError("maxQueuedBytes must be a non-negative safe integer");
    }
    if (!Number.isSafeInteger(this.#drainTimeoutMs) || this.#drainTimeoutMs <= 0) {
      throw new TypeError("drainTimeoutMs must be a positive safe integer");
    }
  }

  get closed(): boolean {
    return this.#closed;
  }

  get blocked(): boolean {
    return this.#blocked;
  }

  writeEvent(event: string | Uint8Array): boolean {
    if (this.#closed || this.#target.destroyed || this.#target.writableEnded) return false;
    const bytes = typeof event === "string" ? Buffer.from(event) : Buffer.from(event);

    if (this.#active === null && this.#queue.length === 0) {
      // The event that owns the writer is legal even when it is larger than
      // the backlog bound. It is emitted incrementally in fixed-size slices.
      this.#active = bytes;
      this.#activeOffset = 0;
    } else {
      if (this.#queuedBytes + bytes.byteLength > this.#maxQueuedBytes) {
        this.#fail("backlog-overflow");
        return false;
      }
      this.#queue.push(bytes);
      this.#queuedBytes += bytes.byteLength;
    }

    void this.#pump();
    return !this.#closed;
  }

  /** Heartbeats are expendable and never add pressure behind real data. */
  writeHeartbeat(event = ": heartbeat\n\n"): boolean {
    if (this.#closed || this.#blocked || this.#active !== null || this.#queue.length > 0) {
      return false;
    }
    return this.writeEvent(event);
  }

  dispose(): void {
    this.#closed = true;
    this.#active = null;
    this.#activeOffset = 0;
    this.#queue.length = 0;
    this.#queuedBytes = 0;
  }

  async #pump(): Promise<void> {
    if (this.#pumping || this.#closed) return;
    this.#pumping = true;
    try {
      while (!this.#closed) {
        if (this.#active === null) {
          const next = this.#queue.shift();
          if (!next) return;
          this.#queuedBytes -= next.byteLength;
          this.#active = next;
          this.#activeOffset = 0;
        }

        while (this.#activeOffset < this.#active.byteLength) {
          if (this.#target.destroyed || this.#target.writableEnded) {
            this.#fail("socket-failure");
            return;
          }
          const end = Math.min(this.#activeOffset + this.#sliceBytes, this.#active.byteLength);
          let accepted: boolean;
          try {
            accepted = this.#target.write(this.#active.subarray(this.#activeOffset, end));
          } catch {
            this.#fail("socket-failure");
            return;
          }
          this.#activeOffset = end;
          if (!accepted) {
            this.#blocked = true;
            const result = await this.#waitForDrain();
            this.#blocked = false;
            if (result !== "drain") {
              this.#fail(result === "timeout" ? "drain-timeout" : "socket-failure");
              return;
            }
          }
        }

        this.#active = null;
        this.#activeOffset = 0;
      }
    } finally {
      this.#pumping = false;
    }
  }

  #waitForDrain(): Promise<"drain" | "timeout" | "failure"> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: "drain" | "timeout" | "failure"): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.#target.off("drain", onDrain);
        this.#target.off("close", onFailure);
        this.#target.off("error", onFailure);
        resolve(result);
      };
      const onDrain = (): void => finish("drain");
      const onFailure = (): void => finish("failure");
      const timer = setTimeout(() => finish("timeout"), this.#drainTimeoutMs);
      timer.unref();
      this.#target.once("drain", onDrain);
      this.#target.once("close", onFailure);
      this.#target.once("error", onFailure);
    });
  }

  #fail(reason: SseWriterFailure): void {
    if (this.#closed) return;
    this.dispose();
    this.#onFailure(reason);
  }
}
