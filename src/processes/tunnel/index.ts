/**
 * Tunnel process — manages the mindstudio-local dev tunnel.
 *
 * Handles startup config, stdout event parsing, and WS action handlers
 * for scenarios, schema sync, and role impersonation.
 */

import type { ProcessManager } from '../process-manager.js';
import { parseTunnelLine } from './events.js';
import { createLogger } from '../../logger.js';

const log = createLogger('tunnel');

type ActionHandler = (params: Record<string, unknown>) => Promise<unknown>;

export interface TunnelCallbacks {
  onSessionStarted: (proxyPort: number) => void;
  broadcast: (event: string, data: Record<string, unknown>) => void;
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
    case 'session-started':
      if (typeof tunnelEvent.proxyPort === 'number') {
        log.info(`Proxy port: ${tunnelEvent.proxyPort}`);
        cb.onSessionStarted(tunnelEvent.proxyPort);
      }
      break;
    case 'session-expired':
      log.error('Session expired by platform');
      break;
    case 'connection-warning':
      log.warn(`Connection warning: ${tunnelEvent.message}`);
      break;
    case 'connection-restored':
      log.info('Connection restored');
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
      send('runScenario', { scenarioId });
      return {};
    },
    tunnelSyncSchema: async () => {
      send('syncSchema');
      return {};
    },
    tunnelListScenarios: async () => {
      send('listScenarios');
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
      send('clearImpersonation');
      return {};
    },
    tunnelListRoles: async () => {
      send('listRoles');
      return {};
    },
  };
}
