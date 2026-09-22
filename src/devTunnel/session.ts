/**
 * The dev tunnel's session lifecycle.
 *
 * Driven by the C&C server, which spawns this process and is its only client
 * (`processes/tunnel/`). Outputs structured JSON events to stdout (one per
 * line, newline-delimited); the C&C reads these to track session state, method
 * execution, errors, and connection health.
 *
 * Does NOT start a dev server — the C&C manages that. The port to proxy to is
 * read from the web interface's config on every session start.
 *
 * @module
 */

import { DevRunner } from './execution/runner.ts';
import { DevProxy } from './proxy/proxy.ts';
import { BrowserSupervisor } from './browser/index.ts';
import {
  syncSchema,
  sessionDataSourcesPayload,
  sessionMethodsPayload,
} from './api.ts';
import { detectAppConfig, readTableSources } from './config/app-config.ts';
import { findWebInterface, getWebInterfaceConfig } from '../appConfig/read.ts';
import { initRequestLog, closeRequestLog } from './logging/request-log.ts';
import { initBrowserLog, closeBrowserLog } from './logging/browser-log.ts';
import { subscribeDevEvents } from './ipc/session-events.ts';
import {
  setupStdinCommands,
  type LifecycleHooks,
  type SessionState,
} from './stdin-commands/index.ts';
import { emitEvent } from './ipc/ipc.ts';
import {
  getApiKey,
  getApiBaseUrl,
  getUserId,
  getDbWsUrl,
  getLogLevel,
} from './config.ts';
import {
  createLogger,
  setLogLevel,
  setSinkLogLevel,
} from './logging/logger.ts';
import { stablePort } from './stablePort.ts';
import {
  resolveConfigSnapshot,
  hasLoopCriticalGap,
} from './interfaces/read-config.ts';
import { join } from 'node:path';

const log = createLogger('session');
const browserLog = createLogger('browser');

/**
 * The proxy binds to loopback, unconditionally.
 *
 * This was a `--bind` flag defaulting to 127.0.0.1, for a laptop that wanted the
 * proxy off the network. It was then hard-coded to 0.0.0.0 on the reasoning that
 * "the sandbox proxy reaches it from outside the container" — which is WRONG, and
 * the wide bind it justified was gratuitous. Nothing outside the container ever
 * touches this port. A box exposes exactly one (CNC_PORT 4387, the C&C's), and
 * every consumer of this one is a sibling process on loopback:
 *
 *  - the C&C reverse-proxies preview/HMR traffic to `http://127.0.0.1:<port>`
 *    (`server/index.ts` setProxyTarget)
 *  - the sandbox's headless Chrome loads `http://127.0.0.1:<port>/?ms_sandbox=1`
 *    (`browser/launcher.ts`), and `resolveAppUrl` / the off-origin watchdog both
 *    resolve against that same origin
 *
 * So loopback is both sufficient and the accurate description of how this is
 * reached. It also makes the origin reported to the platform match the origin the
 * in-box browser actually presents — see the setProxyUrl call below.
 */
const BIND_ADDRESS = '127.0.0.1';

/**
 * Which of a person's two dev workspaces the platform files this session under.
 *
 * Always `sandbox`: this tunnel only ever runs in a dev box. It was a
 * `--dev-origin` flag because the same binary also ran on a laptop, where a
 * developer with a local session would otherwise have shared one dev release,
 * one data plane and one poll queue with their box, and the two would race for
 * every request. The platform still accepts `cli` for releases that already
 * exist — see `getDevRelease` in youai-api — we just never send it.
 */
const DEV_ORIGIN = 'sandbox' as const;

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

async function startSession(
  cwd: string,
  state: SessionState,
  shutdown: () => Promise<void>,
): Promise<boolean> {
  // Read fresh config
  const initialConfig = await detectAppConfig(cwd);
  if (!initialConfig) {
    emitEvent({
      event: 'config-error',
      message: 'No valid mindstudio.json found in ' + cwd,
    });
    return false;
  }

  // Resolve the config snapshot we push as the dev release, retrying while a
  // declared agent/voice interface can't be read yet — compiled files still
  // materializing after a snapshot resume, or the manifest caught mid-write.
  // Publishing a release with a declared-but-null agent is what surfaces as
  // `no_agent_config` for the whole session (RPT-1232).
  const {
    appConfig,
    bundle: configBundle,
    unresolvedDeclared,
  } = await resolveConfigSnapshot(cwd, initialConfig);

  if (!appConfig.appId) {
    emitEvent({
      event: 'config-error',
      message: 'Missing "appId" in mindstudio.json',
    });
    return false;
  }

  if (hasLoopCriticalGap(unresolvedDeclared)) {
    // Don't publish a broken release. Return false so the boot-retry + 15s
    // degraded loop re-attempts a full start until the interface resolves.
    log.warn(
      'Config snapshot missing a declared agent/voice interface; deferring start',
      { unresolvedDeclared },
    );
    return false;
  }

  state.appConfig = appConfig;

  // Cache the web config snapshot for hot-apply diffing, and resolve the dev
  // server's port from it — on EVERY start, so a `devPort` edit in web.json
  // reaches the proxy on the restart it triggers. (This used to prefer a
  // `--port` the C&C computed once at boot, which made that restart a no-op.)
  // 5173 is Vite's default, for a web.json that leaves it unsaid.
  const webConfig = getWebInterfaceConfig(appConfig);
  state.lastWebConfig = webConfig;
  const devPort = webConfig?.devPort ?? 5173;

  emitEvent({
    event: 'session-starting',
    appId: appConfig.appId,
    name: appConfig.name,
  });

  try {
    // Start platform session
    const runner = new DevRunner(appConfig.appId, cwd, {
      devOrigin: DEV_ORIGIN,
      methods: sessionMethodsPayload(appConfig.methods),
      dataSources: sessionDataSourcesPayload(appConfig.dataSources),
      config: configBundle,
    });
    runner.setAppConfig(appConfig);
    const session = await runner.start();
    state.runner = runner;

    // Initialize logs
    initRequestLog(cwd);
    initBrowserLog(cwd);

    // Sync schema
    if (appConfig.tables.length > 0) {
      try {
        const tableSources = readTableSources(appConfig, cwd);
        if (tableSources.length > 0) {
          const syncResult = await syncSchema(
            appConfig.appId,
            session.sessionId,
            tableSources,
          );
          session.databases = syncResult.databases;
          emitEvent({
            event: 'schema-sync-completed',
            created: syncResult.created,
            altered: syncResult.altered,
            errors: syncResult.errors,
          });
        } else {
          log.warn('No table source files found, skipping schema sync', {
            expected: appConfig.tables.map((t) => t.path),
          });
        }
      } catch (err) {
        emitEvent({
          event: 'schema-sync-completed',
          created: [],
          altered: [],
          errors: [err instanceof Error ? err.message : 'Schema sync failed'],
        });
      }
    }

    // Start or reuse proxy
    if (session.clientContext) {
      if (state.proxy) {
        // The proxy instance persists across restarts on purpose — restarting it
        // would drop every browser-agent WebSocket and the sandbox Chrome's
        // connection — so re-point it at this session instead. All three values
        // can change between sessions; see `updateSession`.
        state.proxy.updateSession({
          clientContext: session.clientContext,
          appId: appConfig.appId,
          upstreamPort: devPort,
        });
      } else {
        const proxy = new DevProxy(
          devPort,
          session.clientContext,
          appConfig.appId,
          BIND_ADDRESS,
        );
        const proxyPort = await proxy.start(stablePort(appConfig.appId));
        state.proxy = proxy;
        state.proxyPort = proxyPort;
      }

      // Reported to the platform on every heartbeat, and NOT merely cosmetic: the
      // platform turns this into a redirect allow-list origin so "Sign in with
      // Remy" can round-trip through a dev session (youai-api
      // `resolveDevRedirectOrigins`, via `DevSessionDao.getProxyUrl`).
      //
      // It must therefore be the origin the in-box browser actually presents.
      // While BIND_ADDRESS was 0.0.0.0 this reported `http://localhost:<port>`,
      // but every navigation in the box goes to `http://127.0.0.1:<port>` — and
      // those are different origins, so the allow-listed one never matched the
      // real one. Following the bind fixes that alignment; youai-api's own
      // comment already describes the value as looking like http://127.0.0.1:5123.
      runner.setProxyUrl(`http://${BIND_ADDRESS}:${state.proxyPort}`);
      runner.setProxy(state.proxy);

      // The sandbox-side headless Chrome. Connects back to the proxy as just
      // another WS client; the proxy registers it with mode='headless' and
      // getCommandTarget() prefers it for automation. Viewport follows the web
      // interface's defaultPreviewMode so mobile-first apps render at mobile
      // dimensions in the sandbox Chrome too.
      if (state.proxyPort !== null && !state.browser) {
        const previewMode =
          state.lastWebConfig?.defaultPreviewMode ?? 'desktop';
        const proxy = state.proxy;
        const supervisor = new BrowserSupervisor(
          state.proxyPort,
          previewMode,
          // Block `running` until the browser-agent WS hello arrives —
          // replaces the launcher's old `networkidle0` readiness check,
          // which the telemetry-presence SSE defeats.
          () => proxy?.waitForHeadlessClient(15_000) ?? Promise.resolve(),
          // Page left the app origin (e.g. a delegated sign-in redirect) —
          // fail the in-flight command with an accurate error instead of a
          // generic disconnect at grace-expiry.
          (url) => proxy?.failPendingCommandsOffOrigin(url),
        );
        state.browser = supervisor;
        supervisor.start().catch((err) => {
          browserLog.warn('Sandbox browser failed to start', {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
    }

    emitEvent({
      event: 'session-started',
      sessionId: session.sessionId,
      releaseId: session.releaseId,
      proxyPort: state.proxyPort,
      proxyUrl: state.proxyPort
        ? `http://${BIND_ADDRESS}:${state.proxyPort}/`
        : null,
      roles: appConfig.roles.map((r) => ({
        id: r.id,
        name: r.name ?? r.id,
        description: r.description,
      })),
      scenarios: appConfig.scenarios.map((s) => ({
        id: s.id,
        name: s.name ?? s.export,
        description: s.description,
        path: s.path,
        roles: s.roles,
      })),
    });

    // Subscribe to runner events
    state.unsubscribers.push(...subscribeDevEvents(shutdown));

    // Start polling for platform method requests now that schema sync and
    // proxy are set up. Starting earlier would risk executing methods against
    // stale session state (e.g. missing tables).
    runner.startPolling();

    return true;
  } catch (err) {
    emitEvent({
      event: 'config-error',
      message: err instanceof Error ? err.message : 'Failed to start session',
    });
    return false;
  }
}

/**
 * A declared table source file changed — the C&C's workspace watcher says so.
 * Re-read the sources and sync the schema; no session restart.
 */
async function resyncTables(cwd: string, state: SessionState): Promise<void> {
  if (!state.runner || !state.appConfig?.appId) {
    return;
  }
  const session = state.runner.getSession();
  if (!session) {
    return;
  }

  emitEvent({ event: 'schema-sync-started' });
  log.info('Table source file changed, syncing schema');

  try {
    const tableSources = readTableSources(state.appConfig, cwd);
    if (tableSources.length > 0) {
      const result = await syncSchema(
        state.appConfig.appId,
        session.sessionId,
        tableSources,
      );
      session.databases = result.databases;
      emitEvent({
        event: 'schema-sync-completed',
        created: result.created,
        altered: result.altered,
        errors: result.errors,
      });
      log.info('Schema sync complete', {
        created: result.created,
        altered: result.altered,
      });
    } else {
      log.warn('Table source file change detected but file(s) still missing', {
        expected: state.appConfig.tables.map((t) => t.path),
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Schema sync failed';
    emitEvent({
      event: 'schema-sync-completed',
      created: [],
      altered: [],
      errors: [message],
    });
    log.warn('Schema sync failed', { error: message });
  }
}

/**
 * Hot-apply a web.json `defaultPreviewMode` change without a full session
 * restart. Returns true if the change was hot-applied (and the caller should
 * stop processing); false if the change requires a full restart and the
 * caller should fall through to the existing restart path.
 *
 * Conditions for hot-apply:
 *   - The changed file is the currently-active web.json (resolved via
 *     interfaces[].path).
 *   - A sandbox browser supervisor exists.
 *   - The only field that differs from the cached snapshot is
 *     `defaultPreviewMode`. devPort/devCommand changes still need a restart
 *     because they affect proxy upstream + sandbox-manager-spawned dev server.
 *
 * The restart a devPort change falls through to re-points the proxy:
 * `startSession` resolves the port from the fresh web.json and passes it to
 * `DevProxy.updateSession`. Both halves of that were once missing — the proxy's
 * `upstreamPort` was `readonly`, and the port came from a `--port` flag the C&C
 * computed once at boot — so the restart this function defers to changed
 * nothing.
 */
async function tryHotApplyWebConfigChange(
  state: SessionState,
  cwd: string,
  changedPath: string,
): Promise<boolean> {
  if (!state.appConfig || !state.browser || !state.lastWebConfig) {
    return false;
  }

  const webIface = findWebInterface(state.appConfig);
  if (!webIface?.path || changedPath !== join(cwd, webIface.path)) {
    return false;
  }

  // Re-read: `state.appConfig` still carries web.json as it was at start.
  const fresh = await detectAppConfig(cwd);
  const newWeb = fresh ? getWebInterfaceConfig(fresh) : null;
  if (!newWeb) {
    return false;
  }

  const onlyPreviewModeChanged =
    newWeb.devPort === state.lastWebConfig.devPort &&
    newWeb.devCommand === state.lastWebConfig.devCommand &&
    newWeb.defaultPreviewMode !== state.lastWebConfig.defaultPreviewMode;
  if (!onlyPreviewModeChanged) {
    return false;
  }

  const nextMode = newWeb.defaultPreviewMode ?? 'desktop';
  log.info('web.json change is preview-mode-only, hot-applying', {
    from: state.lastWebConfig.defaultPreviewMode,
    to: nextMode,
  });
  state.lastWebConfig = newWeb;
  // Best-effort: the supervisor already logs a failed reload, and its
  // watchdog recovers a page that's genuinely wedged. The config change
  // itself has been applied either way.
  await state.browser.setPreviewMode(nextMode).catch(() => {});
  return true;
}

/** Tear down the runner, logs, and watchers. Proxy stays alive for reuse. */
async function teardownRunner(state: SessionState): Promise<void> {
  for (const unsub of state.unsubscribers) {
    unsub();
  }
  state.unsubscribers = [];

  if (state.runner) {
    await state.runner.stop().catch(() => {});
    state.runner = null;
  }

  closeRequestLog();
  closeBrowserLog();
}

/** Full teardown including proxy. Used on process shutdown. */
async function teardownAll(state: SessionState): Promise<void> {
  await teardownRunner(state);

  if (state.browser) {
    await state.browser.stop().catch(() => {});
    state.browser = null;
  }

  state.proxy?.stop();
  state.proxy = null;
  state.proxyPort = null;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Start the dev tunnel. Runs until the process is signalled.
 */
export async function startHeadless(): Promise<void> {
  // No listeners in this process, so its two thresholds are one setting.
  const logLevel = getLogLevel();
  setLogLevel(logLevel);
  setSinkLogLevel(logLevel);

  // The C&C spawns this process with the workspace as its cwd.
  const cwd = process.cwd();

  const apiKey = getApiKey();
  const userId = getUserId();
  log.info('Startup config', {
    apiBaseUrl: getApiBaseUrl(),
    hasApiKey: !!apiKey,
    apiKeyPrefix: apiKey ? apiKey.slice(0, 8) + '...' : null,
    hasUserId: !!userId,
    userId: userId ?? null,
    // Stated rather than omitted when absent: null is the normal, correct value
    // and it selects the worker's fetch transport (see getDbWsUrl). A future
    // debugger wants to read that off the line, not infer it from a gap.
    dbWsUrl: getDbWsUrl() ?? null,
    cwd,
  });

  const state: SessionState = {
    runner: null,
    proxy: null,
    browser: null,
    appConfig: null,
    lastWebConfig: null,
    proxyPort: null,
    unsubscribers: [],
  };

  let restarting = false;
  let stopping = false;
  let degradedRetryTimer: ReturnType<typeof setInterval> | null = null;
  const shutdown = async () => {
    if (stopping) {
      return;
    }
    stopping = true;
    if (degradedRetryTimer) {
      clearInterval(degradedRetryTimer);
      degradedRetryTimer = null;
    }
    emitEvent({ event: 'session-stopping' });
    await teardownAll(state);
    emitEvent({ event: 'session-stopped' });
  };

  process.on('SIGTERM', () => {
    shutdown().then(() => process.exit(0));
  });
  process.on('SIGINT', () => {
    shutdown().then(() => process.exit(0));
  });

  // Initial session start — retry a few times with backoff before degrading.
  // Snapshot resumes often hit a transient 400 from /manage/start because the
  // platform-side session state is stale. A short retry usually recovers.
  const MAX_START_RETRIES = 5;
  let started = false;
  for (let attempt = 1; attempt <= MAX_START_RETRIES && !stopping; attempt++) {
    started = await startSession(cwd, state, shutdown);
    if (started) {
      break;
    }
    if (attempt < MAX_START_RETRIES) {
      const delay = Math.min(1000 * 2 ** (attempt - 1), 10_000);
      log.info(`Start failed, retrying in ${delay}ms`, {
        attempt,
        maxAttempts: MAX_START_RETRIES,
      });
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  if (!started && !stopping) {
    emitEvent({
      event: 'degraded-state',
      reason:
        'Config invalid or missing at boot. Waiting for valid mindstudio.json.',
    });
    log.warn(
      'Booting in degraded state — no valid config. Watching for changes.',
    );

    // Periodically retry in degraded state (covers transient platform issues
    // that outlast the initial retry window, e.g. long snapshot resume).
    degradedRetryTimer = setInterval(async () => {
      if (stopping || restarting || state.runner) {
        if (state.runner && degradedRetryTimer) {
          clearInterval(degradedRetryTimer);
          degradedRetryTimer = null;
        }
        return;
      }
      restarting = true;
      try {
        log.info('Retrying session start from degraded state');
        const ok = await startSession(cwd, state, shutdown);
        if (ok) {
          emitEvent({
            event: 'degraded-state-resolved',
            appId: state.appConfig?.appId,
          });
          log.info('Recovered from degraded state');
          if (degradedRetryTimer) {
            clearInterval(degradedRetryTimer);
            degradedRetryTimer = null;
          }
        }
      } finally {
        restarting = false;
      }
    }, 15_000);
  }

  // Workspace changes arrive from the C&C's watcher as stdin commands
  // (`config-file-changed`, `table-file-changed`); these are what they run.
  // This process used to watch the files itself — a second chokidar tree over
  // the same workspace, which also saw the C&C's own JSON repairs as edits and
  // restarted the session for them.
  //
  // Most config changes trigger a full session restart (validate before
  // teardown so corrupt writes don't kill the running session). The one
  // exception is web.json's `defaultPreviewMode` — that hot-applies via the
  // supervisor without a restart, so rrweb continuity and cookies survive.
  const lifecycle: LifecycleHooks = {
    onTableFileChanged: () => resyncTables(cwd, state),
    onConfigFileChanged: async (changedPath) => {
      // A change landing mid-restart is not lost: that restart reads the disk.
      if (stopping || restarting) {
        return;
      }

      // Try the hot-apply fast path first — only triggers when the changed
      // file IS the active web.json AND the only field that differs is
      // defaultPreviewMode. Anything else falls through to the restart path.
      if (await tryHotApplyWebConfigChange(state, cwd, changedPath)) {
        return;
      }

      restarting = true;
      try {
        emitEvent({ event: 'config-changed', path: changedPath });

        // Validate BEFORE tearing down the running session
        const newConfig = await detectAppConfig(cwd);
        if (!newConfig || !newConfig.appId) {
          emitEvent({
            event: 'config-error',
            message: 'mindstudio.json is invalid — keeping current session',
          });
          log.warn(
            'Config change detected but file is invalid, keeping current session',
          );
          return;
        }

        const wasDegraded = !state.runner;
        await teardownRunner(state);
        const ok = await startSession(cwd, state, shutdown);
        if (ok) {
          if (wasDegraded) {
            emitEvent({
              event: 'degraded-state-resolved',
              appId: newConfig.appId,
            });
            log.info('Recovered from degraded state');
            if (degradedRetryTimer) {
              clearInterval(degradedRetryTimer);
              degradedRetryTimer = null;
            }
          }
          if (state.proxy) {
            state.proxy.broadcastToClients('reload');
          }
        } else {
          emitEvent({
            event: 'degraded-state',
            reason:
              'Session restart failed after config change. Will retry on next change.',
          });
          log.warn('Session restart failed, entering degraded state');
        }
      } finally {
        restarting = false;
      }
    },
  };

  // Stdin command loop
  setupStdinCommands(state, cwd, lifecycle);

  // Keep the process alive — the poll loop runs in DevRunner
  await new Promise<void>(() => {});
}
