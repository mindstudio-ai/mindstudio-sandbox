/**
 * Tunnel process — manages the mindstudio-local dev tunnel.
 *
 * Handles startup config, stdout event parsing, and WS action handlers
 * for scenarios and role impersonation.
 */

import type { ProcessManager } from '../ProcessManager.js';
import { parseTunnelLine } from './events.js';
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
      'debug',
    ],
    cwd: config.workspaceDir,
    stdin: true,
    restartOnCrash: true,
    maxRestarts: 5,
    critical: true,
    onStdout: (line) => handleStdout(line, callbacks),
  });
}

function handleStdout(line: string, cb: TunnelCallbacks): void {
  const tunnelEvent = parseTunnelLine(line);
  if (!tunnelEvent) {
    return;
  }

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
    case 'method-started':
      log.debug(`Method started: ${tunnelEvent.method} (${tunnelEvent.id})`);
      break;
    case 'method-completed':
      if (tunnelEvent.success) {
        log.debug(
          `Method completed: ${tunnelEvent.id} (${tunnelEvent.duration}ms)`,
        );
      } else {
        log.warn(
          `Method failed: ${tunnelEvent.id} — ${tunnelEvent.error ?? 'unknown error'}`,
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
    case 'command-error':
      log.warn(`Command error: ${tunnelEvent.message}`);
      break;
    case 'error':
      log.error(`Error: ${tunnelEvent.message}`);
      break;
  }
}

/** Create WS action handlers for tunnel commands. */
export function createTunnelActions(
  pm: ProcessManager,
): Record<string, ActionHandler> {
  function send(action: string, extra?: Record<string, unknown>): void {
    if (pm.getState('tunnel') !== 'running') {
      throw new Error('tunnel not running');
    }
    pm.writeStdin('tunnel', JSON.stringify({ action, ...extra }));
  }

  return {
    tunnelRunScenario: async (p) => {
      const { scenarioId } = p as { scenarioId: string };
      if (!scenarioId) {
        throw new Error('Missing "scenarioId" parameter');
      }
      log.info(`Running scenario: ${scenarioId}`);
      send('run-scenario', { scenarioId });
      return {};
    },
    tunnelImpersonate: async (p) => {
      const { roles } = p as { roles: string[] };
      if (!Array.isArray(roles)) {
        throw new Error('Missing "roles" parameter (array of role IDs)');
      }
      log.info(`Impersonating roles: ${roles.join(', ')}`);
      send('impersonate', { roles });
      return {};
    },
    tunnelClearImpersonation: async () => {
      log.info('Clearing role impersonation');
      send('clear-impersonation');
      return {};
    },
  };
}
