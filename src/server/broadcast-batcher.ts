/**
 * Batches WebSocket broadcast events and flushes them on a short interval.
 * Every message sent is always an array (even with a single event), reducing
 * per-line WS overhead from chatty process output.
 */

const DEFAULT_INTERVAL_MS = 100;

export interface BroadcastBatcherOpts {
  flush: (event: string, batch: unknown[]) => void;
  intervalMs?: number;
}

export class BroadcastBatcher {
  private buckets = new Map<string, unknown[]>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushFn: (event: string, batch: unknown[]) => void;

  constructor(opts: BroadcastBatcherOpts) {
    this.flushFn = opts.flush;
    const interval = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.timer = setInterval(() => this.flushAll(), interval);
    this.timer.unref();
  }

  push(event: string, data: unknown): void {
    let bucket = this.buckets.get(event);
    if (!bucket) {
      bucket = [];
      this.buckets.set(event, bucket);
    }
    bucket.push(data);
  }

  /** Force flush all buckets immediately. */
  flushNow(): void {
    this.flushAll();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.flushAll();
  }

  private flushAll(): void {
    for (const [event, bucket] of this.buckets) {
      if (bucket.length > 0) {
        this.flushFn(event, bucket);
      }
    }
    this.buckets.clear();
  }
}
