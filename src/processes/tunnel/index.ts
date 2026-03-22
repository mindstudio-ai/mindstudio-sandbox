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
    case 'scenario-completed': {
      if (tunnelEvent.success) {
        log.info(
          `Scenario completed: ${tunnelEvent.id} (${tunnelEvent.duration}ms)`,
        );
      } else {
        log.warn(
          `Scenario failed: ${tunnelEvent.id} — ${tunnelEvent.error ?? 'unknown error'}`,
        );
      }
      const resolver = scenarioResolvers.get(tunnelEvent.id);
      if (resolver) {
        scenarioResolvers.delete(tunnelEvent.id);
        resolver({
          success: tunnelEvent.success,
          duration: tunnelEvent.duration,
          roles: tunnelEvent.roles,
          error: tunnelEvent.error,
        });
      }
      break;
    }
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
    case 'method-run-completed': {
      if (tunnelEvent.success) {
        log.info(
          `Method run completed: ${tunnelEvent.method} (${tunnelEvent.duration}ms)`,
        );
      } else {
        log.warn(
          `Method run failed: ${tunnelEvent.method} — ${tunnelEvent.error?.message ?? 'unknown error'}`,
        );
      }
      const methodResolver = methodRunResolvers.get(tunnelEvent.method);
      if (methodResolver) {
        methodRunResolvers.delete(tunnelEvent.method);
        methodResolver(tunnelEvent);
      }
      break;
    }
    case 'browser-completed': {
      log.info(
        `Browser command completed: ${tunnelEvent.steps.length} step(s) (${tunnelEvent.duration}ms)`,
      );
      const browserResolver = browserResolvers.shift();
      if (browserResolver) {
        browserResolver(tunnelEvent);
      }
      break;
    }
    case 'screenshot-completed': {
      log.info(
        `Screenshot captured: ${tunnelEvent.width}x${tunnelEvent.height} (${tunnelEvent.duration}ms)`,
      );
      const screenshotResolver = screenshotResolvers.shift();
      if (screenshotResolver) {
        screenshotResolver(tunnelEvent);
      }
      break;
    }
    case 'browser-status': {
      const resolver = browserStatusResolvers.shift();
      if (resolver) {
        resolver(tunnelEvent.connected);
      }
      break;
    }
    case 'command-error':
      log.warn(`Command error: ${tunnelEvent.message}`);
      break;
    case 'error':
      log.error(`Error: ${tunnelEvent.message}`);
      break;
  }
}

// ---------------------------------------------------------------------------
// Synchronous scenario execution
// ---------------------------------------------------------------------------

interface ScenarioResult {
  success: boolean;
  duration: number;
  roles: string[];
  error?: string;
}

const scenarioResolvers = new Map<string, (result: ScenarioResult) => void>();

/** Run a scenario and wait for the tunnel's completion event. */
export function runScenarioAndWait(
  pm: ProcessManager,
  scenarioId: string,
): Promise<ScenarioResult> {
  if (pm.getState('tunnel') !== 'running') {
    return Promise.resolve({
      success: false,
      duration: 0,
      roles: [],
      error: 'tunnel not running',
    });
  }
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      scenarioResolvers.delete(scenarioId);
      resolve({
        success: false,
        duration: 0,
        roles: [],
        error: 'timeout (30s)',
      });
    }, 30_000);

    scenarioResolvers.set(scenarioId, (result) => {
      clearTimeout(timeout);
      resolve(result);
    });

    pm.writeStdin(
      'tunnel',
      JSON.stringify({ action: 'run-scenario', scenarioId }),
    );
  });
}

// ---------------------------------------------------------------------------
// Synchronous method execution
// ---------------------------------------------------------------------------

interface MethodRunResult {
  method: string;
  success: boolean;
  output: unknown | null;
  error: {
    message: string;
    stack?: string;
    code?: string;
    statusCode?: number;
    cause?: unknown;
  } | null;
  stdout: string[];
  duration: number;
}

const methodRunResolvers = new Map<string, (result: MethodRunResult) => void>();

/** Run a method and wait for the tunnel's completion event. */
export function runMethodAndWait(
  pm: ProcessManager,
  method: string,
  input?: Record<string, unknown>,
): Promise<MethodRunResult> {
  if (pm.getState('tunnel') !== 'running') {
    return Promise.resolve({
      method,
      success: false,
      output: null,
      error: { message: 'tunnel not running' },
      stdout: [],
      duration: 0,
    });
  }
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      methodRunResolvers.delete(method);
      resolve({
        method,
        success: false,
        output: null,
        error: { message: 'timeout (30s)' },
        stdout: [],
        duration: 0,
      });
    }, 30_000);

    methodRunResolvers.set(method, (result) => {
      clearTimeout(timeout);
      resolve(result);
    });

    pm.writeStdin(
      'tunnel',
      JSON.stringify({ action: 'run-method', method, input: input ?? {} }),
    );
  });
}

// ---------------------------------------------------------------------------
// Synchronous browser command execution
// ---------------------------------------------------------------------------

interface BrowserResult {
  id?: string;
  steps: Array<{
    index: number;
    command: string;
    result: string;
    error?: string;
  }>;
  snapshot: string;
  duration: number;
}

const browserResolvers: Array<(result: BrowserResult) => void> = [];

/** Send browser commands and wait for the completion event. */
export function runBrowserAndWait(
  pm: ProcessManager,
  steps: unknown[],
): Promise<BrowserResult> {
  if (pm.getState('tunnel') !== 'running') {
    return Promise.resolve({
      steps: [],
      snapshot: '',
      duration: 0,
    });
  }
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      const idx = browserResolvers.indexOf(resolverFn);
      if (idx !== -1) {
        browserResolvers.splice(idx, 1);
      }
      resolve({
        steps: [{ index: 0, command: '', result: '', error: 'timeout (120s)' }],
        snapshot: '',
        duration: 0,
      });
    }, 120_000);

    const resolverFn = (result: BrowserResult) => {
      clearTimeout(timeout);
      resolve(result);
    };

    browserResolvers.push(resolverFn);

    pm.writeStdin('tunnel', JSON.stringify({ action: 'browser', steps }));
  });
}

// ---------------------------------------------------------------------------
// Synchronous screenshot capture
// ---------------------------------------------------------------------------

interface ScreenshotResult {
  url: string;
  width: number;
  height: number;
  duration: number;
}

const screenshotResolvers: Array<(result: ScreenshotResult) => void> = [];

/** Capture a screenshot and wait for the CDN URL. */
export function takeScreenshotAndWait(
  pm: ProcessManager,
): Promise<ScreenshotResult> {
  if (pm.getState('tunnel') !== 'running') {
    return Promise.resolve({
      url: '',
      width: 0,
      height: 0,
      duration: 0,
    });
  }
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      const idx = screenshotResolvers.indexOf(resolverFn);
      if (idx !== -1) {
        screenshotResolvers.splice(idx, 1);
      }
      resolve({ url: '', width: 0, height: 0, duration: 0 });
    }, 30_000);

    const resolverFn = (result: ScreenshotResult) => {
      clearTimeout(timeout);
      resolve(result);
    };

    screenshotResolvers.push(resolverFn);
    pm.writeStdin('tunnel', JSON.stringify({ action: 'screenshot' }));
  });
}

// ---------------------------------------------------------------------------
// Browser status
// ---------------------------------------------------------------------------

const browserStatusResolvers: Array<(connected: boolean) => void> = [];

/** Check whether the user's browser is connected to the tunnel. */
export function getBrowserStatus(
  pm: ProcessManager,
): Promise<{ connected: boolean }> {
  if (pm.getState('tunnel') !== 'running') {
    return Promise.resolve({ connected: false });
  }
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      const idx = browserStatusResolvers.indexOf(resolverFn);
      if (idx !== -1) {
        browserStatusResolvers.splice(idx, 1);
      }
      resolve({ connected: false });
    }, 5_000);

    const resolverFn = (connected: boolean) => {
      clearTimeout(timeout);
      resolve({ connected });
    };

    browserStatusResolvers.push(resolverFn);
    pm.writeStdin('tunnel', JSON.stringify({ action: 'browser-status' }));
  });
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
