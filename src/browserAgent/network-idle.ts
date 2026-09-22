/**
 * Network idle tracker — counts in-flight fetch/XHR requests.
 * Used by the snapshot walker to wait for the page to settle before
 * walking the DOM.
 */

import { getState } from './state';

export function trackRequestStart(): void {
  getState().networkIdle.activeRequests++;
}

export function trackRequestEnd(): void {
  const s = getState().networkIdle;
  s.activeRequests = Math.max(0, s.activeRequests - 1);
}

// How many in-flight requests still count as idle. Zero is unreachable for any
// app that polls or holds a stream open — the count never touches 0, so the wait
// ran its full timeout on every snapshot and bought nothing. Remy-built apps poll
// routinely: a live dashboard refetching every second, with requests that overlap
// once the backend is slow. Allowing a couple in flight lets steady-state polling
// read as idle, while a genuine cascade — each response kicking off more work —
// still holds the gate.
const IDLE_CONCURRENCY = 2;

/**
 * Wait until in-flight requests sit at or below `IDLE_CONCURRENCY` for a settling
 * period (to catch cascading requests where one fetch triggers another).
 *
 * Resolves immediately if already idle, and resolves rather than rejecting on
 * timeout — this is a best-effort settle, never a reason to fail a command.
 */
export function waitForNetworkIdle(
  timeout = 5000,
  settleMs = 200,
): Promise<void> {
  const isIdle = () =>
    getState().networkIdle.activeRequests <= IDLE_CONCURRENCY;

  return new Promise((resolve) => {
    const deadline = Date.now() + timeout;
    let settleTimer: ReturnType<typeof setTimeout> | null = null;

    function check() {
      if (Date.now() > deadline) {
        if (settleTimer) {
          clearTimeout(settleTimer);
        }
        // Resolve anyway — don't block the snapshot forever
        resolve();
        return;
      }

      if (isIdle()) {
        // Start the settle countdown
        if (!settleTimer) {
          settleTimer = setTimeout(() => {
            if (isIdle()) {
              resolve();
            } else {
              // Traffic picked up during the settle — reset
              settleTimer = null;
              check();
            }
          }, settleMs);
        }
      } else {
        // Too many requests in flight — reset settle timer
        if (settleTimer) {
          clearTimeout(settleTimer);
          settleTimer = null;
        }
        setTimeout(check, 50);
      }
    }

    check();
  });
}
