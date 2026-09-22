/**
 * The sandbox-hosted Chrome's lifecycle, as the tunnel reports it.
 *
 * Kept as module state so a reconnecting editor gets the current picture from
 * the init frame (`server/context.ts`) instead of waiting for the next
 * transition — Chrome can sit in `running` for hours.
 */

import { createLogger } from '../../logger.ts';
import type { SandboxBrowserStateEvent } from '../../devTunnel/protocol.ts';
import type { TunnelCallbacks } from './index.ts';

const log = createLogger('tunnel');

export interface SandboxBrowserState {
  state:
    | 'starting'
    | 'running'
    | 'crashed'
    | 'restarting'
    | 'degraded'
    | 'stopped'
    | 'unknown';
  pid: number | null;
  previewMode: 'desktop' | 'mobile' | null;
  viewport: string | null;
  executablePath: string | null;
  /** Timestamp of most recent `running` transition. */
  startedAt: number | null;
  /** Timestamp of most recent `crashed` transition. */
  lastCrashAt: number | null;
  lastCrashExitCode: number | null;
  lastCrashSignal: string | null;
  /** Cumulative within session; reset to 0 on every `running`. */
  consecutiveFailures: number;
  /** Total `running` transitions after the first. */
  restartCount: number;
  degradedReason: 'repeated-crashes' | 'no-executable' | null;
}

function initialSandboxBrowserState(): SandboxBrowserState {
  return {
    state: 'unknown',
    pid: null,
    previewMode: null,
    viewport: null,
    executablePath: null,
    startedAt: null,
    lastCrashAt: null,
    lastCrashExitCode: null,
    lastCrashSignal: null,
    consecutiveFailures: 0,
    restartCount: 0,
    degradedReason: null,
  };
}

let sandboxBrowserState: SandboxBrowserState = initialSandboxBrowserState();

export function getSandboxBrowserState(): SandboxBrowserState {
  return { ...sandboxBrowserState };
}

/**
 * Apply a sandbox-browser-state transition to module state, notify the
 * ResourceMonitor about PID add/remove, and broadcast the new state so
 * the frontend can render Chrome's lifecycle without polling.
 */
export function handleSandboxBrowserState(
  event: SandboxBrowserStateEvent,
  cb: TunnelCallbacks,
): void {
  const prev = sandboxBrowserState;
  const next: SandboxBrowserState = { ...prev };

  switch (event.state) {
    case 'starting':
      next.state = 'starting';
      if (event.previewMode !== undefined) {
        next.previewMode = event.previewMode ?? null;
      }
      break;
    case 'running':
      next.state = 'running';
      next.pid = event.pid;
      next.previewMode = event.previewMode ?? null;
      next.viewport = event.viewport;
      next.executablePath = event.executablePath;
      next.startedAt = Date.now();
      next.consecutiveFailures = 0;
      next.degradedReason = null;
      // Count subsequent `running` transitions as restarts (the very first
      // one is the initial launch).
      if (prev.state !== 'unknown' && prev.state !== 'starting') {
        next.restartCount = prev.restartCount + 1;
      } else if (prev.startedAt !== null) {
        next.restartCount = prev.restartCount + 1;
      }
      cb.onSandboxBrowserPid(event.pid);
      break;
    case 'crashed':
      next.state = 'crashed';
      next.pid = null;
      next.lastCrashAt = Date.now();
      next.lastCrashExitCode = event.exitCode;
      next.lastCrashSignal = event.signal;
      next.consecutiveFailures = event.consecutiveFailures;
      cb.onSandboxBrowserPid(null);
      log.warn('Sandbox Chrome crashed', {
        exitCode: event.exitCode,
        signal: event.signal,
        consecutiveFailures: event.consecutiveFailures,
      });
      break;
    case 'restarting':
      next.state = 'restarting';
      break;
    case 'degraded':
      next.state = 'degraded';
      next.pid = null;
      next.degradedReason = event.reason;
      // Narrowed on `reason`, not on `typeof event.consecutiveFailures`: only
      // the repeated-crashes variant carries a count, and saying so through the
      // discriminant means the compiler proves the field is there instead of
      // the code testing whether it turned up.
      if (event.reason === 'repeated-crashes') {
        next.consecutiveFailures = event.consecutiveFailures;
      }
      cb.onSandboxBrowserPid(null);
      log.error('Sandbox Chrome degraded — automation disabled for session', {
        reason: event.reason,
      });
      break;
    case 'stopped':
      // Full reset — counters are per-session, not per-sandbox-lifetime.
      Object.assign(next, initialSandboxBrowserState(), { state: 'stopped' });
      cb.onSandboxBrowserPid(null);
      break;
  }

  sandboxBrowserState = next;
  cb.broadcast('sandboxBrowserStateChanged', { sandboxBrowser: next });
}
