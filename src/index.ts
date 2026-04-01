import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { loadConfig, type Config } from './config.js';
import {
  installTunnel,
  installAgent,
  installAgentSdk,
  installLsp,
  writeTunnelConfig,
  cloneAppRepo,
  configureGit,
  readAppConfig,
  installDependencies,
  setBootstrapRegistry,
} from './bootstrap.js';
import { ProcessRegistry } from './processes/ProcessRegistry.js';
import { ProcessManager } from './processes/ProcessManager.js';
import {
  startTunnel,
  createTunnelActions,
  sendCommand as sendTunnelCommand,
} from './processes/tunnel/index.js';
import {
  startAgent,
  sendAgentCommand,
  sendToolResult,
} from './processes/agent/index.js';
import { createAgentActions } from './processes/agent/actions.js';
import { startDevServer } from './processes/devServer/index.js';
import { ResourceMonitor } from './processes/ResourceMonitor.js';
import { BroadcastBatcher } from './server/BroadcastBatcher.js';
import {
  startServer,
  broadcast,
  stopServer,
  setStatus,
  setProxyTarget,
  flushHmr,
} from './server/index.js';
import { ctx } from './server/context.js';
import { handlers } from './server/wsHandlers/index.js';
import { EditorStateManager } from './server/states/EditorStateManager.js';
import { FileTreeManager } from './server/states/FileTreeManager.js';
import { SpecFileTreeManager } from './server/states/SpecFileTreeManager.js';
import { SpecEditorStateManager } from './server/states/SpecEditorStateManager.js';
import { LspClient } from './lsp/client.js';
import { LspSidecar } from './lsp/sidecar.js';
import { initFilesystem } from './server/wsHandlers/filesystem.js';
import { initShell } from './server/wsHandlers/shell.js';
import { initPty, closeAllPty } from './server/wsHandlers/pty.js';
import { stopWatcher } from './fileWatcher/index.js';
import {
  initState,
  restoreState,
  saveState,
  stopAutoSave,
  markDirty,
} from './state.js';
import { createLogger, onLog } from './logger.js';
import { DraftSnapshotManager } from './projectStatus/DraftSnapshotManager.js';
import {
  initProjectStatus,
  getProjectStatus,
} from './projectStatus/ProjectStatusManager.js';
import type { AppConfig } from './types.js';
import { toolRegistry } from './agentTools/index.js';
import { setupFileWatcher } from './fileWatcher/index.js';

const log = createLogger('controller');

// ---------------------------------------------------------------------------
// State manager construction
// ---------------------------------------------------------------------------

interface Managers {
  logsDir: string;
  batcher: BroadcastBatcher;
  registry: ProcessRegistry;
  processManager: ProcessManager;
  fileTreeManager: FileTreeManager;
  editorManager: EditorStateManager;
  specFileTreeManager: SpecFileTreeManager;
  specEditorManager: SpecEditorStateManager;
  resourceMonitor: ResourceMonitor;
}

function createStateManagers(config: Config): Managers {
  const batcher = new BroadcastBatcher({
    flush: (event, batch) => broadcast(event, { batch }),
  });

  // logsDir is created later (after clone) but registry needs the path now.
  // appendLog silently ignores write failures if the dir doesn't exist yet.
  const logsDir = path.join(config.workspaceDir, '.logs');

  const registry = new ProcessRegistry({
    onStateChange: (event) => {
      batcher.push('processStateChanged', event);
      markDirty();
    },
    logsDir,
  });

  const fileTreeManager = new FileTreeManager({
    workspaceDir: config.workspaceDir,
    getExpandedDirs: () => editorManager.getExpandedDirs(),
    onChange: (tree) => {
      broadcast('fileTreeChanged', { fileTree: tree });
    },
  });

  const editorManager = new EditorStateManager((state) => {
    broadcast('editorStateChanged', { editorState: state });
    markDirty();
    fileTreeManager.onExpandedDirsChanged();
  });

  const specFileTreeManager = new SpecFileTreeManager({
    workspaceDir: config.workspaceDir,
    onChange: (tree) => {
      broadcast('specFileTreeChanged', { specFileTree: tree });
    },
    getAppName: () => ctx.appConfig?.name ?? null,
  });

  const specEditorManager = new SpecEditorStateManager((state) => {
    broadcast('specEditorStateChanged', { specEditorState: state });
    markDirty();
  });

  const resourceMonitor = new ResourceMonitor({
    registry,
    onSnapshot: (snapshot) => {
      broadcast('resourceSnapshot', snapshot);
    },
  });

  // System pseudo-process for C&C server logs
  registry.register('system', 'system', 'cnc-server');
  registry.setState('system', 'running');
  onLog((entry) => {
    registry.appendLog('system', entry.message, {
      level: entry.level,
      module: entry.module,
      ...entry.ctx,
    });
  });

  setBootstrapRegistry(registry);
  const processManager = new ProcessManager(registry);

  return {
    logsDir,
    batcher,
    registry,
    processManager,
    fileTreeManager,
    editorManager,
    specFileTreeManager,
    specEditorManager,
    resourceMonitor,
  };
}

// ---------------------------------------------------------------------------
// Service startup (LSP, dev server, tunnel, agent)
// ---------------------------------------------------------------------------

async function startServices(
  config: Config,
  managers: Managers,
  appConfig: AppConfig,
  progress: (step: string, message: string) => void,
  snapshotManager: DraftSnapshotManager,
): Promise<{ lspClient: LspClient; lspSidecar: LspSidecar }> {
  const { processManager, registry } = managers;

  // TypeScript language server
  log.info('Starting LSP...');
  const lspClient = new LspClient();
  await lspClient.start(config.workspaceDir, registry);
  ctx.lspClient = lspClient;

  // LSP HTTP sidecar for remy
  const lspSidecar = new LspSidecar(lspClient);
  await lspSidecar.start(4388);
  lspSidecar.setProcessManager(processManager);
  log.info('LSP sidecar ready on port 4388');

  // Dev server
  const webInterface = appConfig.interfaces.find((i) => i.type === 'web');
  const webConfig = webInterface?.config as
    | { devCommand?: string; devPort?: number }
    | undefined;
  const devPort = webConfig?.devPort ?? 5173;
  const devCommand = webConfig?.devCommand ?? 'npm run dev';
  const webDir = webInterface
    ? path.resolve(config.workspaceDir, path.dirname(webInterface.path))
    : null;

  if (webDir) {
    progress('devServer', `Starting dev server: ${devCommand}`);
    startDevServer(processManager, { command: devCommand, cwd: webDir });
  } else {
    log.info('No web interface, skipping dev server');
  }

  // Tunnel
  progress('tunnel', 'Starting dev tunnel...');
  startTunnel(
    processManager,
    { workspaceDir: config.workspaceDir, devPort },
    {
      onSessionStarted: (session) => {
        if (session.proxyPort != null) {
          setProxyTarget(session.proxyPort);
        }
        ctx.tunnelSession = session;
      },
      onSessionEnded: () => {
        ctx.tunnelSession = null;
        ctx.activeImpersonation = null;
      },
      onImpersonationChanged: (roles) => {
        ctx.activeImpersonation = roles;
      },
      broadcast,
    },
  );

  // Agent
  progress('agent', 'Starting coding agent...');
  const toolContext: import('./agentTools/types.js').ToolContext = {
    sendToolResult: (id, result) => sendToolResult(processManager, id, result),
    broadcast,
    getProjectStatus,
    sendTunnelCommand: (cmd, params, timeout) =>
      sendTunnelCommand(processManager, cmd, params, timeout),
    sendAgentCommand: (action, params, timeout) =>
      sendAgentCommand(processManager, action, params, timeout),
    workspaceDir: config.workspaceDir,
    readAppConfig: () => readAppConfig(config.workspaceDir),
    setAppConfig: (updated) => {
      ctx.appConfig = updated;
    },
  };
  startAgent(
    processManager,
    {
      workspaceDir: config.workspaceDir,
      apiKey: config.apiKey,
      apiBaseUrl: config.apiBaseUrl,
    },
    {
      broadcast,
      onEditsFinished: flushHmr,
      onExternalTool: (id, name, input) => {
        const handler = toolRegistry.get(name);
        if (!handler) {
          return false;
        }
        return handler.handle(id, input, toolContext);
      },
      onTurnDone: () => snapshotManager.scheduleSnapshot(),
    },
  );

  return { lspClient, lspSidecar };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  log.info(
    `Starting — Node ${process.version}, PID ${process.pid}, cwd ${process.cwd()}`,
  );

  // 1. Config
  const config = loadConfig();
  log.info(
    `Config loaded — port=${config.port}, workspace=${config.workspaceDir}`,
  );

  // 2. Create state managers
  const managers = createStateManagers(config);

  // 3. Graceful shutdown
  let lspClientRef: LspClient | null = null;
  const snapshotManager = new DraftSnapshotManager(config.workspaceDir);
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    log.info('Shutting down...');
    managers.registry.setState('system', 'stopped');
    managers.resourceMonitor.stop();
    managers.batcher.stop();
    stopAutoSave();
    await saveState();
    await snapshotManager.snapshot();
    snapshotManager.stop();
    closeAllPty();
    stopWatcher();
    lspClientRef?.stop();
    await managers.processManager.stopAll();
    await stopServer();
    log.info('Shutdown complete');
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

  // 4. Start HTTP/WS server (health returns "bootstrapping")
  await startServer(config.port, config.sandboxToken, config.workspaceDir);
  ctx.batcher = managers.batcher;
  ctx.registry = managers.registry;
  ctx.editorState = managers.editorManager;
  ctx.fileTreeManager = managers.fileTreeManager;
  ctx.specEditorState = managers.specEditorManager;
  ctx.specFileTreeManager = managers.specFileTreeManager;
  ctx.resourceMonitor = managers.resourceMonitor;
  log.info(`Server listening on port ${config.port}`);

  const progress = (step: string, message: string) => {
    log.info(`[${step}] ${message}`);
    broadcast('bootstrapProgress', { step, message });
  };

  try {
    // 5. Install binaries
    await Promise.all([
      installTunnel(progress),
      installAgent(progress),
      installAgentSdk(progress),
      installLsp(progress),
    ]);

    // 6. Prepare workspace
    await writeTunnelConfig(config);
    await cloneAppRepo(config, progress);
    configureGit(config.workspaceDir);
    fsSync.mkdirSync(managers.logsDir, { recursive: true });
    await snapshotManager.restore();

    // 7. Init project status (after snapshot restore so file is available)
    initProjectStatus(config.workspaceDir);

    // 8. Read app config
    const appConfig = await readAppConfig(config.workspaceDir);
    ctx.appConfig = appConfig;
    log.info(`App: ${appConfig.name} (${appConfig.appId})`);

    // 9. Install dependencies
    await installDependencies(config.workspaceDir, progress);

    // 10. Init handlers
    initFilesystem(config.workspaceDir);
    initShell(config.workspaceDir, managers.registry);
    initPty(config.workspaceDir, managers.registry, managers.batcher);
    ctx.processManager = managers.processManager;
    Object.assign(handlers, createTunnelActions(managers.processManager));
    Object.assign(
      handlers,
      createAgentActions(managers.processManager, {
        onProjectStatusChanged: () => {
          broadcast('projectStatusChanged', getProjectStatus());
        },
      }),
    );

    // 11. Restore state
    initState(
      config.workspaceDir,
      managers.registry,
      managers.editorManager,
      managers.specEditorManager,
    );
    await restoreState();

    // Re-set system pseudo-process to running (restoreState may have
    // overwritten it with "stopped" from the previous session's snapshot).
    managers.registry.setState('system', 'running');

    if (managers.editorManager.isEmpty()) {
      managers.editorManager.expandFromAppConfig(appConfig);
    }
    if (managers.specEditorManager.isEmpty()) {
      try {
        await fs.access(path.join(config.workspaceDir, 'src', 'app.md'));
        managers.specEditorManager.openFile('src/app.md', false);
      } catch {
        // src/app.md doesn't exist
      }
    }

    // 12. Build initial file trees
    await managers.fileTreeManager.buildVisibleTree();
    await managers.specFileTreeManager.buildTree();

    // 13. Start services
    const { lspClient, lspSidecar } = await startServices(
      config,
      managers,
      appConfig,
      progress,
      snapshotManager,
    );
    lspClientRef = lspClient;

    // 14. File watcher
    setupFileWatcher(config, managers, appConfig, lspSidecar);

    // 15. Start periodic snapshots
    snapshotManager.start();

    // Ready
    setStatus('ready');
    progress('ready', 'C&C server is ready');
    log.info('Bootstrap complete');
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Bootstrap failed';
    log.error(`Bootstrap failed: ${message}`);
    if (err instanceof Error && err.stack) {
      log.error(err.stack);
    }
    setStatus('error');
    broadcast('bootstrapProgress', { step: 'error', message });
    process.exit(1);
  }
}

main().catch((err) => {
  log.error(`Fatal error in main(): ${err}`);
  log.error(err.stack ?? '');
  process.exit(1);
});
