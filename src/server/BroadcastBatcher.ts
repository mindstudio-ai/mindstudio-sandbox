/**
 * Coalesces WebSocket broadcast events so chatty process output doesn't become one frame per line.
 * Every message sent is always an array, even for a single event, so consumers have one shape.
 *
 * THROTTLED, not debounced, and the distinction is the whole design. `ptyOutput` shares this with
 * `fileChanged` and `processStateChanged`, and a terminal is interactive: with a trailing-edge-only
 * timer every keystroke echo waited out the interval before leaving the box (0-50ms, mean 25ms),
 * now on top of the browser -> sandbox-proxy -> box hop. That paid the latency cost on the one case
 * that feels it and collected the frame-count benefit on floods, which cannot feel it.
 *
 * So the first event after an idle window goes out immediately and anything arriving during the
 * window rides the timer. A keystroke is always the first event after an idle window; `cat` of a
 * large file is not.
 */

const DEFAULT_INTERVAL_MS = 50;

/**
 * Flush a bucket early once it holds this many events, regardless of the timer.
 *
 * Without it a bucket grows unbounded inside the window, so `yes` or a big `cat` arrives as one
 * enormous frame per interval instead of a stream. That is worse than slow output: the editor
 * treats a frame it cannot parse as the connection being gone, so a flood can present as a dropped
 * socket. This bounds EVENTS per frame, not bytes — a single pty chunk is already bounded by the
 * pty's own read buffer, so the two together keep frames to a sane size without this class needing
 * to know how to measure what it is carrying.
 */
const DEFAULT_MAX_BATCH = 128;

export interface BroadcastBatcherOpts {
  flush: (event: string, batch: unknown[]) => void;
  intervalMs?: number;
  maxBatch?: number;
}

export class BroadcastBatcher {
  private buckets = new Map<string, unknown[]>();
  /** Per event, when it last went on the wire — what makes the throttle leading-edge. */
  private lastFlushed = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushFn: (event: string, batch: unknown[]) => void;
  private intervalMs: number;
  private maxBatch: number;

  constructor(opts: BroadcastBatcherOpts) {
    this.flushFn = opts.flush;
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.maxBatch = opts.maxBatch ?? DEFAULT_MAX_BATCH;
    this.timer = setInterval(() => this.flushAll(), this.intervalMs);
    this.timer.unref();
  }

  push(event: string, data: unknown): void {
    let bucket = this.buckets.get(event);
    if (!bucket) {
      bucket = [];
      this.buckets.set(event, bucket);
    }
    bucket.push(data);

    // Leading edge: idle long enough that nothing is waiting, so don't make this event wait either.
    // `?? 0` means the first event of a session always goes straight out.
    const idleFor = Date.now() - (this.lastFlushed.get(event) ?? 0);
    if (idleFor >= this.intervalMs || bucket.length >= this.maxBatch) {
      this.flushEvent(event);
    }
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

  private flushEvent(event: string): void {
    const bucket = this.buckets.get(event);
    if (!bucket || bucket.length === 0) {
      return;
    }
    this.buckets.delete(event);
    this.lastFlushed.set(event, Date.now());
    this.flushFn(event, bucket);
  }

  private flushAll(): void {
    // Snapshot the keys: `flushEvent` deletes from `buckets`, and the flush callback can push more
    // events synchronously (a process state change fanning out), which would mutate what we iterate.
    for (const event of [...this.buckets.keys()]) {
      this.flushEvent(event);
    }
  }
}
