/**
 * Structured boot progress, for the editor's loading overlay.
 *
 * This rides the LOG LINE, not the C&C socket. The sandbox orchestrator
 * (`youai-api/src/sandboxOrchestrator`) follows the pod's stdout, batches it every 500ms and hands
 * it to the API, which re-emits it to the editor's platform socket — and that is
 * the only channel open during a boot, because `waitForReady` gates on `/health` reporting `ready`,
 * so the platform has no pod address and the editor has no C&C connection until the boot is already
 * over. `broadcast('bootstrapProgress', ...)` during boot reaches nobody.
 *
 * The shape is deliberately generic — a phase plus an optional counter — rather than boot-specific,
 * so the same overlay can later narrate a deploy or a branch-environment build.
 *
 * Every field is optional to the consumer. Boxes running an older image emit the same human-readable
 * messages with no `boot` payload at all and live for up to 12h after a rollout, so the display has
 * to work without this and simply get better with it.
 */

import { createLogger } from './logger.ts';

/** Phases the boot already has. Ordered; the overlay renders them in this order. */
export type BootPhaseId =
  | 'provision'
  | 'server'
  | 'tooling'
  | 'restore'
  | 'deps'
  | 'services'
  | 'ready';

export interface BootCounter {
  done: number;
  /**
   * Absent when we genuinely don't know it — an extract whose snapshot predates
   * `uncompressedBytes`, for instance. The overlay shows a rising figure with no bar rather than
   * inventing a denominator.
   */
  total?: number | null;
  /**
   * `dirs` exists because the install phase has no finer measure honestly available — npm prints no
   * machine-readable progress — and a phase that routinely runs 30s cannot be left with nothing on
   * screen. Directories finished out of directories found is coarse, but both ends are observed.
   */
  unit: 'bytes' | 'files' | 'dirs';
  /**
   * What the BAR should read, when that is not `done / total`.
   *
   * The two are different questions for a stepwise counter. Two package directories are two events,
   * so the text can only ever say "1 of 2" — but they are not the same size, and a bar that jumps to
   * 50% when the small one finishes is claiming half the work is done when it was a seventh of it.
   * So the text counts events and the bar carries their weight. Omit it and the bar falls back to
   * the ratio, which is right for a counter whose units are already uniform.
   */
  fraction?: number;
  /** Units per second, so the overlay can interpolate between updates instead of freezing. */
  rate?: number;
  /** Short verb for the counter line: `Downloading`, `Unpacking`. */
  label?: string;
}

export interface BootProgress {
  phase: BootPhaseId;
  state?: 'active' | 'done';
  /** One short clause under the phase name. Survives the phase completing. */
  detail?: string;
  /** True when the phase was satisfied by something already on the box or the node. */
  cached?: boolean;
  counter?: BootCounter;
}

/** The log-line field the payload travels in. Mirrored in remy-frontend's overlay parser. */
const BOOT_FIELD = 'boot';

const log = createLogger('boot');

/**
 * Emit a phase transition. The message is what a human reads in the log stream; the payload is what
 * the overlay reads. Both go out on one line so they can never disagree about ordering.
 */
export function bootPhase(message: string, progress: BootProgress): void {
  log.info(message, { [BOOT_FIELD]: progress });
}

/**
 * A counter update, rate-limited.
 *
 * Called from tar's checkpoint stream and the download's chunk handler, both of which fire far more
 * often than anyone can read. The wire batches at 500ms, so anything faster than that is discarded
 * downstream anyway — this just avoids generating it. Interpolation on the client, not more
 * updates here, is what makes the number move smoothly.
 */
export function makeCounterEmitter(
  phase: BootPhaseId,
  intervalMs = 400,
): (counter: BootCounter, message: string) => void {
  let lastAt = 0;
  return (counter, message) => {
    const now = Date.now();
    if (now - lastAt < intervalMs) {
      return;
    }
    lastAt = now;
    log.info(message, { [BOOT_FIELD]: { phase, state: 'active', counter } });
  };
}
