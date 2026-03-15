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
import { startTunnel } from './processes/tunnel/index.js';
import { startAgent } from './processes/agent/index.js';
import { startDevServer } from './processes/dev-server/index.js';
import { ResourceMonitor } from './processes/resource-monitor.js';
import { BroadcastBatcher } from './server/broadcast-batcher.js';
import {
  startServer,
  broadcast,
  stopServer,
  setStatus,
  setProxyTarget,
  setAppConfig,
  setProcessManager,
  setLspClient,
  setBatcher,
  setRegistry,
  setEditorState,
  setResourceMonitor,
} from './server/ws-server.js';
import { EditorStateManager } from './server/editor-state.js';
import { LspClient } from './lsp/client.js';
import { LspSidecar } from './lsp/sidecar.js';
import { initFilesystem } from './server/handlers/filesystem.js';
import { initSearch } from './server/handlers/search.js';
import { initShell } from './server/handlers/shell.js';
import { startWatcher, stopWatcher } from './processes/file-watcher.js';
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

  // Start resource monitor — polls every 5s, broadcasts to clients
  const resourceMonitor = new ResourceMonitor({
    registry,
    onSnapshot: (snapshot) => {
      broadcast(
        'resourceSnapshot',
        snapshot as unknown as Record<string, unknown>,
      );
    },
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
    resourceMonitor.stop();
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
  setResourceMonitor(resourceMonitor);
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

    // On fresh sessions, pre-expand directories so the user sees their code
    if (editorManager.isEmpty()) {
      editorManager.expandFromAppConfig(appConfig);
    }

    // Start TypeScript language server
    log.info(`(${elapsed()}) Starting LSP...`);
    lspClientInstance = new LspClient();
    await lspClientInstance.start(config.workspaceDir, registry);
    setLspClient(lspClientInstance);

    // Start LSP HTTP sidecar for remy
    const lspSidecar = new LspSidecar(lspClientInstance);
    await lspSidecar.start(4388);
    lspSidecar.setProcessManager(processManager);
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
      startDevServer(processManager, { command: devCommand, cwd: webDir });
    } else {
      log.info(`(${elapsed()}) Step 8: No web interface, skipping dev server`);
    }

    // 9. Start tunnel
    log.info(`(${elapsed()}) Step 9: Starting dev tunnel...`);
    progress('tunnel', 'Starting dev tunnel...');
    startTunnel(
      processManager,
      { workspaceDir: config.workspaceDir, devPort },
      {
        onSessionStarted: (port) => setProxyTarget(port),
        broadcast,
      },
    );

    // 10. Start agent
    log.info(`(${elapsed()}) Step 10: Starting agent...`);
    progress('agent', 'Starting coding agent...');
    startAgent(
      processManager,
      {
        workspaceDir: config.workspaceDir,
        apiKey: config.apiKey,
        apiBaseUrl: config.apiBaseUrl,
      },
      { broadcast },
    );

    // 11. Start file watcher
    log.info(
      `(${elapsed()}) Step 11: Starting file watcher on ${config.workspaceDir}`,
    );
    startWatcher(config.workspaceDir, (filePath, changeType) => {
      broadcast('fileChanged', { path: filePath, changeType });
      if (changeType === 'modified' || changeType === 'created') {
        lspSidecar.onFileChanged(filePath).catch(() => {});
        // Re-read and broadcast manifest when it changes
        if (filePath === 'mindstudio.json') {
          readAppConfig(config.workspaceDir)
            .then((updated) => {
              setAppConfig(updated);
              broadcast('manifestChanged', {
                app: updated as unknown as Record<string, unknown>,
              });
            })
            .catch(() => {});
        }
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
