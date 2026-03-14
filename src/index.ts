import { loadConfig } from './config.js';
import {
  installTunnel,
  installAgent,
  installLsp,
  writeTunnelConfig,
  cloneAppRepo,
  readAppConfig,
  readWebConfig,
  installDependencies,
  setBootstrapRegistry,
} from './bootstrap.js';
import { ProcessRegistry } from './processes/process-registry.js';
import { ProcessManager } from './processes/process-manager.js';
import { BroadcastBatcher } from './server/broadcast-batcher.js';
import {
  startServer,
  broadcast,
  stopServer,
  setStatus,
  setProxyTarget,
  setAppConfig,
  setProcessManager,
  resolveHistoryRequest,
  setLspClient,
  setBatcher,
  setRegistry,
  setEditorState,
} from './server/ws-server.js';
import { EditorStateManager } from './server/editor-state.js';
import { LspClient } from './lsp/client.js';
import { LspSidecar } from './lsp/sidecar.js';
import { initFilesystem } from './server/handlers/filesystem.js';
import { initSearch } from './server/handlers/search.js';
import { initShell } from './server/handlers/shell.js';
import { startWatcher, stopWatcher } from './processes/file-watcher.js';
import { parseTunnelLine } from './processes/tunnel-events.js';
import {
  initState,
  restoreState,
  saveState,
  stopAutoSave,
  markDirty,
} from './state.js';
import { createLogger, onLog } from './logger.js';
import path from 'node:path';

const log = createLogger('cnc');

/** Maps remy's headless event names to our WebSocket event names. */
const AGENT_EVENT_MAP: Record<string, string> = {
  ready: 'agentReady',
  text: 'agentText',
  thinking: 'agentThinking',
  tool_start: 'agentToolStart',
  tool_done: 'agentToolDone',
  turn_done: 'agentTurnDone',
  turn_cancelled: 'agentTurnCancelled',
  error: 'agentError',
  stopping: 'agentStopping',
  stopped: 'agentStopped',
  session_restored: 'agentSessionRestored',
  session_cleared: 'agentSessionCleared',
};

const bootStart = Date.now();

function elapsed(): string {
  return `+${Date.now() - bootStart}ms`;
}

async function main(): Promise<void> {
  log.info('========================================');
  log.info(`C&C Server starting at ${new Date().toISOString()}`);
  log.info(`Node ${process.version}, PID ${process.pid}`);
  log.info(`cwd: ${process.cwd()}`);
  log.info('========================================');

  // 1. Parse config (also sets LOG_LEVEL)
  log.info(`(${elapsed()}) Step 1: Loading config...`);
  const config = loadConfig();
  log.info(
    `(${elapsed()}) Config loaded — port=${config.port}, workspace=${config.workspaceDir}`,
  );

  // Create process registry + batcher early so bootstrap can register
  const batcher = new BroadcastBatcher({
    flush: (event, batch) => broadcast(event, { batch }),
  });

  const registry = new ProcessRegistry({
    onStateChange: (event) => {
      batcher.push('processStateChanged', event);
      markDirty();
    },
    onLogAppend: (name, entry) => {
      batcher.push('processOutput', { process: name, ...entry });
      markDirty();
    },
  });

  // Create editor state manager
  const editorManager = new EditorStateManager((state) => {
    broadcast('editorStateChanged', { editorState: state });
    markDirty();
  });

  // Register system pseudo-process for C&C server logs
  registry.register('system', 'system', 'cnc-server');
  registry.setState('system', 'running');

  onLog((entry) => {
    const stream =
      entry.level === 'error' || entry.level === 'warn' ? 'stderr' : 'stdout';
    registry.appendLog('system', stream, `[${entry.module}] ${entry.message}`);
  });

  // Wire registry into bootstrap and process manager
  setBootstrapRegistry(registry);
  const processManager = new ProcessManager(registry);
  let lspClientInstance: LspClient | null = null;

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    log.info(`(${elapsed()}) Shutting down...`);
    registry.setState('system', 'stopped');
    batcher.stop();
    stopAutoSave();
    await saveState();
    stopWatcher();
    lspClientInstance?.stop();
    await processManager.stopAll();
    await stopServer();
    log.info(`(${elapsed()}) Shutdown complete`);
    process.exit(0);
  };

  process.on('SIGTERM', () => {
    log.info('Received SIGTERM');
    shutdown();
  });
  process.on('SIGINT', () => {
    log.info('Received SIGINT');
    shutdown();
  });
  process.on('uncaughtException', (err) => {
    log.error(`Uncaught exception: ${err.message}`);
    log.error(err.stack ?? '');
  });
  process.on('unhandledRejection', (reason) => {
    log.error(`Unhandled rejection: ${reason}`);
  });

  // 2. Start HTTP/WS server immediately (health returns "bootstrapping")
  log.info(`(${elapsed()}) Step 2: Starting HTTP/WS server...`);
  await startServer(config.port, config.sandboxToken);
  setBatcher(batcher);
  setRegistry(registry);
  setEditorState(editorManager);
  log.info(`(${elapsed()}) Server listening on port ${config.port}`);

  const progress = (step: string, message: string) => {
    log.info(`(${elapsed()}) [${step}] ${message}`);
    broadcast('bootstrapProgress', { step, message });
  };

  try {
    // 3. Install tunnel and agent
    log.info(`(${elapsed()}) Step 3: Installing tunnel and agent...`);
    await Promise.all([
      installTunnel(progress),
      installAgent(progress),
      installLsp(progress),
    ]);
    log.info(`(${elapsed()}) Tunnel and agent install complete`);

    // 4. Write tunnel config
    log.info(`(${elapsed()}) Step 4: Writing tunnel config...`);
    await writeTunnelConfig(config);
    log.info(`(${elapsed()}) Tunnel config written`);

    // 5. Clone app repo (skip if already exists)
    log.info(`(${elapsed()}) Step 5: Cloning app repo...`);
    await cloneAppRepo(config, progress);
    log.info(`(${elapsed()}) App repo ready`);

    // 6. Read app config
    log.info(`(${elapsed()}) Step 6: Reading app config...`);
    const appConfig = await readAppConfig(config.workspaceDir);
    const webConfig = await readWebConfig(config.workspaceDir, appConfig);
    setAppConfig(appConfig);
    log.info(`(${elapsed()}) App: ${appConfig.name} (${appConfig.appId})`);

    const devPort = webConfig?.web.devPort ?? 5173;
    const devCommand = webConfig?.web.devCommand ?? 'npm run dev';
    log.info(
      `(${elapsed()}) Dev server: port=${devPort}, command="${devCommand}"`,
    );

    // 7. Install dependencies
    log.info(`(${elapsed()}) Step 7: Installing dependencies...`);
    await installDependencies(config.workspaceDir, progress);
    log.info(`(${elapsed()}) Dependencies installed`);

    // Init handlers
    log.debug(`(${elapsed()}) Initializing handlers...`);
    initFilesystem(config.workspaceDir);
    initSearch(config.workspaceDir);
    initShell(config.workspaceDir, registry);
    setProcessManager(processManager);

    // Restore persisted state from previous session (if resuming from snapshot)
    initState(config.workspaceDir, registry, editorManager);
    await restoreState();

    // Start TypeScript language server
    log.info(`(${elapsed()}) Starting LSP...`);
    lspClientInstance = new LspClient();
    await lspClientInstance.start(config.workspaceDir);
    setLspClient(lspClientInstance);

    // Start LSP HTTP sidecar for remy
    const lspSidecar = new LspSidecar(lspClientInstance);
    await lspSidecar.start(4388);
    log.info(`(${elapsed()}) LSP sidecar ready on port 4388`);

    // 8. Start dev server
    const webDir = webConfig
      ? path.resolve(
          config.workspaceDir,
          path.dirname(
            appConfig.interfaces.find((i) => i.type === 'web')?.path ?? '',
          ),
        )
      : null;

    if (webDir) {
      log.info(`(${elapsed()}) Step 8: Starting dev server in ${webDir}...`);
      progress('devServer', `Starting dev server: ${devCommand}`);
      const [cmd, ...args] = devCommand.split(' ');
      processManager.start({
        name: 'devServer',
        command: cmd,
        args,
        cwd: webDir,
        restartOnCrash: true,
        maxRestarts: 5,
      });
    } else {
      log.info(`(${elapsed()}) Step 8: No web interface, skipping dev server`);
    }

    // 9. Start tunnel
    log.info(`(${elapsed()}) Step 9: Starting dev tunnel...`);
    progress('tunnel', 'Starting dev tunnel...');
    processManager.start({
      name: 'tunnel',
      command: 'mindstudio-local',
      args: [
        '--headless',
        '--port',
        String(devPort),
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
      onStdout: (line) => {
        const tunnelEvent = parseTunnelLine(line);
        if (tunnelEvent) {
          log.debug(
            `(${elapsed()}) Tunnel event: ${tunnelEvent.event} ${JSON.stringify(tunnelEvent).slice(0, 200)}`,
          );
          broadcast('tunnelEvent', tunnelEvent);

          switch (tunnelEvent.event) {
            case 'session-started':
              if (typeof tunnelEvent.proxyPort === 'number') {
                log.info(
                  `(${elapsed()}) Tunnel proxy port: ${tunnelEvent.proxyPort}`,
                );
                setProxyTarget(tunnelEvent.proxyPort);
              }
              break;
            case 'session-expired':
              log.error('Tunnel session expired by platform');
              break;
            case 'connection-warning':
              log.warn(`Tunnel connection warning: ${tunnelEvent.message}`);
              break;
            case 'connection-restored':
              log.info('Tunnel connection restored');
              break;
            case 'error':
              log.error(`Tunnel error: ${tunnelEvent.message}`);
              break;
          }
        }
      },
    });

    // 10. Start agent (remy --headless)
    log.info(`(${elapsed()}) Step 10: Starting agent...`);
    progress('agent', 'Starting coding agent...');
    processManager.start({
      name: 'agent',
      command: 'remy',
      args: [
        '--headless',
        '--api-key',
        config.apiKey,
        '--base-url',
        config.apiBaseUrl,
        '--lsp-url',
        'http://localhost:4388',
        '--log-level',
        'debug',
      ],
      cwd: config.workspaceDir,
      stdin: true,
      restartOnCrash: false,
      maxRestarts: 0,
      critical: false,
      onStdout: (line) => {
        try {
          const event = JSON.parse(line);
          if (event && typeof event.event === 'string') {
            if (event.event === 'history') {
              resolveHistoryRequest(event.messages ?? []);
              return;
            }

            const mappedEvent =
              AGENT_EVENT_MAP[event.event] || `agent_${event.event}`;
            const { event: _evt, ...data } = event;
            log.debug(
              `(${elapsed()}) Agent event: ${mappedEvent}${data.text ? ` "${data.text.slice(0, 80)}..."` : ''}`,
            );
            broadcast(mappedEvent, data);
          }
        } catch {
          // Non-JSON stdout from agent — already captured by registry via ProcessManager
        }
      },
    });

    // 11. Start file watcher
    log.info(
      `(${elapsed()}) Step 11: Starting file watcher on ${config.workspaceDir}`,
    );
    startWatcher(config.workspaceDir, (filePath, changeType) => {
      broadcast('fileChanged', { path: filePath, changeType });
      if (changeType === 'modified' || changeType === 'created') {
        lspSidecar.onFileChanged(filePath).catch(() => {});
      }
      if (changeType === 'deleted') {
        editorManager.onFileDeleted(filePath);
      }
    });

    // Ready
    setStatus('ready');
    progress('ready', 'C&C server is ready');
    log.info(`(${elapsed()}) ========================================`);
    log.info(`(${elapsed()}) READY — Bootstrap complete`);
    log.info(`(${elapsed()}) ========================================`);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Bootstrap failed';
    const stack = err instanceof Error ? err.stack : undefined;
    log.error(`(${elapsed()}) ========================================`);
    log.error(`(${elapsed()}) BOOTSTRAP ERROR: ${message}`);
    if (stack) {
      log.error(stack);
    }
    log.error(`(${elapsed()}) ========================================`);
    setStatus('error');
    broadcast('bootstrapProgress', { step: 'error', message });

    log.error('Exiting with code 1');
    process.exit(1);
  }
}

main().catch((err) => {
  log.error(`Fatal error in main(): ${err}`);
  log.error(err.stack ?? '');
  process.exit(1);
});
