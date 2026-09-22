/**
 * Shared types for stdin command handlers.
 *
 * The wire shapes — action names, params, results, error codes — live in
 * `../protocol.ts`, which the C&C side imports too. What is left here is the
 * handler-side machinery that only this process has: the live session objects,
 * the per-command context, and `CommandError`.
 */

import type { DevRunner } from '../execution/runner.ts';
import type { DevProxy } from '../proxy/proxy.ts';
import type { BrowserSupervisor } from '../browser/index.ts';
import type { AppConfig, WebInterfaceConfig } from '../config/types.ts';
import {
  ERROR_CODES,
  type ErrorCode,
  type TunnelAction,
  type TunnelCommandParams,
  type TunnelCommandResult,
} from '../protocol.ts';

export type { ErrorCode } from '../protocol.ts';
export { ERROR_CODES } from '../protocol.ts';

export interface SessionState {
  runner: DevRunner | null;
  proxy: DevProxy | null;
  browser: BrowserSupervisor | null;
  appConfig: AppConfig | null;
  /** Cached web.json snapshot at session start; used to diff hot-applicable
   *  changes (e.g. defaultPreviewMode) against the current state. */
  lastWebConfig: WebInterfaceConfig | null;
  proxyPort: number | null;
  unsubscribers: Array<() => void>;
}

export interface CommandContext {
  state: SessionState;
  cwd: string;
  requestId: string;
  /** Emit a "started" progress event for this command. */
  started(data?: Record<string, unknown>): void;
}

/**
 * A command handler, typed against its action's params and result.
 *
 * `cmd` is the raw parsed line rather than `TunnelCommandParams[A]` alone: the
 * object on the wire also carries `action` and `requestId`, and the values
 * inside it are whatever the caller sent — this process does not get to assume
 * the C&C is well-behaved. Handlers narrow what they read; the value of the
 * generic is on the RESULT, which the compiler now checks against the protocol.
 */
export type CommandHandler<A extends TunnelAction = TunnelAction> = (
  ctx: CommandContext,
  cmd: Partial<TunnelCommandParams[A]> & Record<string, unknown>,
) => Promise<TunnelCommandResult[A]>;

/**
 * Typed error with a machine-readable error code.
 * Thrown by handlers and the proxy dispatch layer.
 */
export class CommandError extends Error {
  constructor(
    message: string,
    public readonly code: ErrorCode,
  ) {
    super(message);
  }
}

/**
 * The code a thrown value declares for itself, if it's one we report.
 *
 * Lets any error carry its own code — `CommandError` and the browser module's
 * `ScreenshotTimeoutError` both do — rather than the router growing an
 * `instanceof` branch per error type and falling back to `INFRASTRUCTURE` for
 * everything else, which labels ordinary slowness as broken plumbing and sends
 * the agent looking in the wrong place.
 */
export function errorCodeOf(err: unknown): ErrorCode | null {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' &&
    (ERROR_CODES as readonly string[]).includes(code)
    ? (code as ErrorCode)
    : null;
}
