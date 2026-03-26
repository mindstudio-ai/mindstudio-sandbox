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
  webInterfaceUrl: string;
}

export interface TunnelCallbacks {
  onSessionStarted: (session: TunnelSessionState) => void;
  onSessionEnded: () => void;
  onImpersonationChanged: (roles: string[] | null) => void;
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
  log.debug(
    `Event: ${tunnelEvent.event} ${JSON.stringify(tunnelEvent).slice(0, 200)}`,
  );
  cb.broadcast('tunnelEvent', tunnelEvent);

  switch (tunnelEvent.event) {
    case 'session-starting':
      log.info(`Session starting: ${tunnelEvent.name} (${tunnelEvent.appId})`);
      break;
    case 'session-started': {
      const {
        sessionId,
        releaseId,
        branch,
        proxyPort,
        proxyUrl,
        webInterfaceUrl,
      } = tunnelEvent;
      log.info(`Session started: proxy=${proxyPort}`);
      cb.onSessionStarted({
        sessionId,
        releaseId,
        branch,
        proxyPort,
        proxyUrl,
        webInterfaceUrl,
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
      log.debug(
        `Platform method started: ${tunnelEvent.method} (${tunnelEvent.id})`,
      );
      break;
    case 'platform-method-completed':
      if (tunnelEvent.success) {
        log.debug(
          `Platform method completed: ${tunnelEvent.id} (${tunnelEvent.duration}ms)`,
        );
      } else {
        log.warn(
          `Platform method failed: ${tunnelEvent.id} — ${tunnelEvent.error ?? 'unknown error'}`,
        );
      }
      break;
    case 'scenario-started':
      log.info(`Scenario started: ${tunnelEvent.name} (${tunnelEvent.id})`);
      break;
    case 'scenario-completed':
      if (tunnelEvent.success) {
        log.info(
          `Scenario completed: ${tunnelEvent.id} (${tunnelEvent.duration}ms)`,
        );
      } else {
        log.warn(
          `Scenario failed: ${tunnelEvent.id} — ${tunnelEvent.error ?? 'unknown error'}`,
        );
      }
      break;
    case 'schema-sync-started':
      log.info('Schema sync started');
      break;
    case 'schema-sync-completed':
      log.info(
        `Schema sync completed: created=${tunnelEvent.created.length}, altered=${tunnelEvent.altered.length}, errors=${tunnelEvent.errors.length}`,
      );
      break;
    case 'impersonation-changed':
      log.info(
        `Impersonation changed: ${tunnelEvent.roles ? tunnelEvent.roles.join(', ') : 'cleared'}`,
      );
      cb.onImpersonationChanged(tunnelEvent.roles);
      break;
    case 'connection-lost':
      log.warn(`Connection lost: ${tunnelEvent.message}`);
      break;
    case 'connection-restored':
      log.info('Connection restored');
      break;
    case 'config-changed':
      log.info('Config changed — session restarting');
      break;
    case 'config-error':
      log.warn(`Config error: ${tunnelEvent.message}`);
      break;
    case 'error':
      log.error(`Error: ${tunnelEvent.message}`);
      break;
  }
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
      const { scenarioId } = p as { scenarioId: string };
      if (!scenarioId) {
        throw new Error('Missing "scenarioId" parameter');
      }
      log.info(`Running scenario: ${scenarioId}`);
      return await sendCommand(pm, 'run-scenario', { scenarioId }, 30_000);
    },
    tunnelRunMethod: async (p) => {
      const { method, input } = p as {
        method: string;
        input?: Record<string, unknown>;
      };
      if (!method) {
        throw new Error('Missing "method" parameter');
      }
      log.info(`Running method: ${method}`);
      return await sendCommand(
        pm,
        'run-method',
        { method, input: input ?? {} },
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
    tunnelScreenshot: async () => {
      return await sendCommand(pm, 'screenshotFullPage', {}, 120_000);
    },
    tunnelBrowserStatus: async () => {
      return await sendCommand(pm, 'browser-status', {}, 5_000);
    },
    tunnelResetBrowser: async () => {
      return await sendCommand(pm, 'reset-browser', {}, 5_000);
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
  };
}
