/**
 * Tunnel process — manages the mindstudio-local dev tunnel.
 *
 * Handles startup config, stdout event parsing, and WS action handlers.
 * Uses requestId-based correlation for all stdin commands.
 */

import type { ProcessManager } from '../ProcessManager.js';
import { parseTunnelMessage } from './events.js';
import type { TunnelEvent } from './events.js';
import { createLogger } from '../../logger.js';

const log = createLogger('tunnel');

type ActionHandler = (params: Record<string, unknown>) => Promise<unknown>;

export interface TunnelSessionState {
  sessionId: string;
  releaseId: string;
  branch: string;
  proxyPort: number | null;
  proxyUrl: string | null;
}

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

export interface TunnelCallbacks {
  onSessionStarted: (session: TunnelSessionState) => void;
  onSessionEnded: () => void;
  onImpersonationChanged: (roles: string[] | null) => void;
  /** Called whenever the sandbox-browser PID should be added/removed from resource monitoring. */
  onSandboxBrowserPid: (pid: number | null) => void;
  broadcast: (event: string, data: Record<string, any>) => void;
}

export function startTunnel(
  pm: ProcessManager,
  config: { workspaceDir: string; devPort: number },
  callbacks: TunnelCallbacks,
): void {
  pm.start({
    name: 'tunnel',
    command: 'mindstudio-local',
    args: [
      '--headless',
      '--port',
      String(config.devPort),
      '--bind',
      '0.0.0.0',
      // Opt in to sandbox-hosted headless Chrome. Tunnel supervises it,
      // prefers it over user-connected browsers for automation commands,
      // and falls through to the user-browser path if Chrome isn't
      // available in the container.
      '--sandbox-browser',
      '--log-level',
      'info',
    ],
    cwd: config.workspaceDir,
    stdin: true,
    restartOnCrash: true,
    maxRestarts: 5,
    critical: true,
    logStdout: false, // stdout is NDJSON protocol traffic, not useful in log file
    onStdout: (line) => handleStdout(line, callbacks),
  });
}

// ---------------------------------------------------------------------------
// requestId-based command correlation
// ---------------------------------------------------------------------------

let requestCounter = 0;
const pending = new Map<
  string,
  {
    resolve: (response: Record<string, unknown>) => void;
    timer: ReturnType<typeof setTimeout>;
  }
>();

/** Send a command to the tunnel and wait for the correlated response. */
export function sendCommand(
  pm: ProcessManager,
  action: string,
  params?: Record<string, unknown>,
  timeoutMs = 30_000,
): Promise<Record<string, unknown>> {
  if (pm.getState('tunnel') !== 'running') {
    return Promise.resolve({ success: false, error: 'tunnel not running' });
  }
  const requestId = `tc-${++requestCounter}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      resolve({ success: false, error: `timeout (${timeoutMs / 1000}s)` });
    }, timeoutMs);

    pending.set(requestId, { resolve, timer });
    pm.writeStdin('tunnel', JSON.stringify({ requestId, action, ...params }));
  });
}

// ---------------------------------------------------------------------------
// Stdout handling
// ---------------------------------------------------------------------------

function handleStdout(line: string, cb: TunnelCallbacks): void {
  const msg = parseTunnelMessage(line);
  if (!msg) {
    return;
  }

  // Command response — resolve pending promise, don't broadcast
  if ('requestId' in msg && msg.requestId) {
    const entry = pending.get(msg.requestId as string);
    if (entry) {
      // Skip intermediate "started" acks — wait for the final result
      if ((msg as Record<string, unknown>).status === 'started') {
        log.debug(
          `Intermediate ack for requestId=${msg.requestId}, waiting for final result`,
          { requestId: msg.requestId as string },
        );
        return;
      }
      pending.delete(msg.requestId as string);
      clearTimeout(entry.timer);
      entry.resolve(msg as Record<string, unknown>);
    } else {
      log.debug(`No pending resolver for requestId=${msg.requestId}`, {
        requestId: msg.requestId as string,
      });
    }
    return;
  }

  // System event — broadcast to frontend + handle
  const tunnelEvent = msg as TunnelEvent;
  log.debug('Tunnel event', { event: tunnelEvent.event });
  cb.broadcast('tunnelEvent', { tunnelEvent });

  switch (tunnelEvent.event) {
    case 'session-starting':
      log.info('Session starting', {
        appId: tunnelEvent.appId,
        name: tunnelEvent.name,
      });
      break;
    case 'session-started': {
      const { sessionId, releaseId, branch, proxyPort, proxyUrl } = tunnelEvent;
      log.info('Session started', { proxyPort, sessionId });
      cb.onSessionStarted({
        sessionId,
        releaseId,
        branch,
        proxyPort,
        proxyUrl,
      });
      break;
    }
    case 'session-stopping':
      log.info('Session stopping');
      cb.onSessionEnded();
      break;
    case 'session-stopped':
      log.info('Session stopped');
      cb.onSessionEnded();
      break;
    case 'session-expired':
      log.error('Session expired by platform');
      cb.onSessionEnded();
      break;
    case 'platform-method-started':
      log.debug('Platform method started', {
        method: tunnelEvent.method,
        id: tunnelEvent.id,
      });
      break;
    case 'platform-method-completed':
      if (tunnelEvent.success) {
        log.debug('Platform method completed', {
          id: tunnelEvent.id,
          duration: tunnelEvent.duration,
        });
      } else {
        log.warn('Platform method failed', {
          id: tunnelEvent.id,
          error: tunnelEvent.error ?? 'unknown error',
        });
      }
      break;
    case 'scenario-started':
      log.info('Scenario started', {
        name: tunnelEvent.name,
        id: tunnelEvent.id,
      });
      break;
    case 'scenario-completed':
      if (tunnelEvent.success) {
        log.info('Scenario completed', {
          id: tunnelEvent.id,
          duration: tunnelEvent.duration,
        });
      } else {
        log.warn('Scenario failed', {
          id: tunnelEvent.id,
          error: tunnelEvent.error ?? 'unknown error',
        });
      }
      break;
    case 'schema-sync-started':
      log.info('Schema sync started');
      break;
    case 'schema-sync-completed':
      log.info('Schema sync completed', {
        created: tunnelEvent.created.length,
        altered: tunnelEvent.altered.length,
        errors: tunnelEvent.errors.length,
      });
      break;
    case 'impersonation-changed':
      log.info('Impersonation changed', {
        roles: tunnelEvent.roles ?? null,
      });
      cb.onImpersonationChanged(tunnelEvent.roles);
      break;
    case 'connection-lost':
      log.warn('Connection lost', { message: tunnelEvent.message });
      break;
    case 'connection-restored':
      log.info('Connection restored');
      break;
    case 'config-changed':
      log.info('Config changed — session restarting');
      break;
    case 'config-error':
      log.warn('Config error', { message: tunnelEvent.message });
      break;
    case 'sandbox-browser-state':
      handleSandboxBrowserState(tunnelEvent, cb);
      break;
    case 'error':
      log.error('Tunnel error', { message: tunnelEvent.message });
      break;
  }
}

/**
 * Apply a sandbox-browser-state transition to module state, notify the
 * ResourceMonitor about PID add/remove, and broadcast the new state so
 * the frontend can render Chrome's lifecycle without polling.
 */
function handleSandboxBrowserState(
  event: Extract<TunnelEvent, { event: 'sandbox-browser-state' }>,
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
      if (typeof event.consecutiveFailures === 'number') {
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

// ---------------------------------------------------------------------------
// WS action handlers
// ---------------------------------------------------------------------------

/** Create WS action handlers for tunnel commands. */
export function createTunnelActions(
  pm: ProcessManager,
): Record<string, ActionHandler> {
  return {
    tunnelRunScenario: async (p) => {
      const { scenarioId, skipTruncate } = p as {
        scenarioId: string;
        skipTruncate?: boolean;
      };
      if (!scenarioId) {
        throw new Error('Missing "scenarioId" parameter');
      }
      log.info(`Running scenario: ${scenarioId}`);
      return await sendCommand(
        pm,
        'run-scenario',
        { scenarioId, ...(skipTruncate ? { skipTruncate } : {}) },
        30_000,
      );
    },
    tunnelRunMethod: async (p) => {
      const { method, input, roles, userId } = p as {
        method: string;
        input?: Record<string, unknown>;
        roles?: string[];
        userId?: string;
      };
      if (!method) {
        throw new Error('Missing "method" parameter');
      }
      log.info(`Running method: ${method}`);
      return await sendCommand(
        pm,
        'run-method',
        {
          method,
          input: input ?? {},
          ...(roles ? { roles } : {}),
          ...(userId ? { userId } : {}),
        },
        30_000,
      );
    },
    tunnelBrowser: async (p) => {
      const { steps } = p as { steps: unknown[] };
      if (!steps) {
        throw new Error('Missing "steps" parameter');
      }
      return await sendCommand(pm, 'browser', { steps }, 120_000);
    },
    tunnelScreenshot: async (p) => {
      const { path } = p as { path?: string };
      return await sendCommand(
        pm,
        'screenshotFullPage',
        path ? { path } : {},
        120_000,
      );
    },
    tunnelImpersonate: async (p) => {
      const { roles } = p as { roles: string[] };
      if (!Array.isArray(roles)) {
        throw new Error('Missing "roles" parameter (array of role IDs)');
      }
      log.info(`Impersonating roles: ${roles.join(', ')}`);
      return await sendCommand(pm, 'impersonate', { roles }, 5_000);
    },
    tunnelClearImpersonation: async () => {
      log.info('Clearing role impersonation');
      return await sendCommand(pm, 'clear-impersonation', {}, 5_000);
    },
    listDatabases: async () => {
      return await sendCommand(pm, 'list-databases', {}, 30_000);
    },
  };
}
