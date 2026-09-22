/**
 * Subscribe to DevRunner events and relay them as system events to stdout.
 * Only relays genuinely unsolicited events (poll-loop methods, connection, auth).
 * Command responses (scenarios, test-user roles) are handled by stdin handlers directly.
 *
 * Returns an array of unsubscribe functions for cleanup on teardown.
 */

import { devRequestEvents } from './events.ts';
import { emitEvent } from './ipc.ts';

export function subscribeDevEvents(
  shutdown: () => Promise<void>,
): Array<() => void> {
  const unsubs: Array<() => void> = [];

  // Platform-triggered method execution (poll loop)
  unsubs.push(
    devRequestEvents.onStart((event) => {
      emitEvent({
        event: 'platform-method-started',
        id: event.id,
        method: event.method,
      });
    }),
  );

  unsubs.push(
    devRequestEvents.onComplete((event) => {
      emitEvent({
        event: 'platform-method-completed',
        id: event.id,
        success: event.success,
        duration: event.duration,
        ...(event.error ? { error: event.error } : {}),
      });
    }),
  );

  // Connection health
  unsubs.push(
    devRequestEvents.onConnectionWarning((message) => {
      emitEvent({ event: 'connection-lost', message });
    }),
  );

  unsubs.push(
    devRequestEvents.onConnectionRestored(() => {
      emitEvent({ event: 'connection-restored' });
    }),
  );

  // Session expiry.
  //
  // Exit ZERO, and that is load-bearing. The C&C spawns us with
  // `restartOnCrash: true, maxRestarts: 5, critical: true`, and its
  // ProcessManager treats any non-zero exit as a crash: it would restart us on
  // a 1s/2s/4s/8s/16s backoff — `restartCount` has no decay window, so those
  // five are the process's whole lifetime — and then, out of restarts on a
  // `critical` child, call `process.exit(1)` on the C&C itself, taking the box
  // with it. An expired or rejected credential is not a crash and a restart
  // cannot fix it: the key comes from our environment, so we would be handed
  // the same rejected value five times in half a minute.
  //
  // Exiting cleanly instead leaves the box up with the tunnel in `stopped`,
  // which the editor's process list already renders, and `session-expired` on
  // the wire for whoever is watching. Degraded and visible beats dead.
  unsubs.push(
    devRequestEvents.onSessionExpired(() => {
      emitEvent({ event: 'session-expired' });
      shutdown().then(() => process.exit(0));
    }),
  );

  return unsubs;
}
