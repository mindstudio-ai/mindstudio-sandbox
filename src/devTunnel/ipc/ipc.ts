/**
 * Central IPC module — every stdout write goes through here.
 *
 * Two distinct message types, and the consumer distinguishes them by the
 * presence of `requestId`:
 * - System events: unsolicited (session lifecycle, connection health, …)
 * - Command responses: always carry `requestId` + `status`
 *
 * Both are typed against `../protocol.ts`, which the C&C side imports too. That
 * is the point: this used to take `(event: string, data?: Record<string,
 * unknown>)`, so nothing checked what went on the wire against what the other
 * half believed it would read.
 *
 * STDOUT IS THE PROTOCOL CHANNEL. Nothing else may write to it — logs go to
 * stderr via `logging/logger.ts`, and a stray `console.log` anywhere in this
 * process corrupts the stream.
 */

import type {
  TunnelAction,
  TunnelCommandResult,
  TunnelEvent,
} from '../protocol.ts';

function write(payload: unknown): void {
  process.stdout.write(JSON.stringify(payload) + '\n');
}

/**
 * Emit a system event.
 *
 * Takes the whole event object rather than a name plus a payload, so the
 * discriminated union does the work: `emitEvent({ event: 'session-starting',
 * appId, name })` is checked in one step, and the `sandbox-browser-state`
 * sub-shapes need no `Extract<>` at the call site.
 */
export function emitEvent(event: TunnelEvent): void {
  write(event);
}

/** Acknowledge that a command has begun. Carries no result. */
export function emitStarted(
  action: TunnelAction,
  requestId: string,
  data?: Record<string, unknown>,
): void {
  write({ event: action, requestId, status: 'started', ...data });
}

/** Answer a command with its result. */
export function emitCompleted<A extends TunnelAction>(
  action: A,
  requestId: string,
  result: TunnelCommandResult[A],
): void {
  write({ event: action, requestId, status: 'completed', ...result });
}

/**
 * Answer a command that was never recognised.
 *
 * Separate from `emitCompleted` because the action is, by definition, not a
 * `TunnelAction` — it is whatever string arrived — so it cannot be typed
 * against the result map.
 */
export function emitUnknownAction(action: string, requestId: string): void {
  write({
    event: action,
    requestId,
    status: 'completed',
    success: false,
    error: `Unknown action: ${action}`,
    errorCode: 'UNKNOWN_ACTION',
  });
}
