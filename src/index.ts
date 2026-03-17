import fs from 'node:fs/promises';
import path from 'node:path';
import { loadConfig, type Config } from './config.js';
import {
  installTunnel,
  installAgent,
  installLsp,
  writeTunnelConfig,
  cloneAppRepo,
  configureGit,
  readAppConfig,
  readWebConfig,
  installDependencies,
  setBootstrapRegistry,
} from './bootstrap.js';
import { ProcessRegistry } from './processes/ProcessRegistry.js';
import { ProcessManager } from './processes/ProcessManager.js';
import { startTunnel, createTunnelActions } from './processes/tunnel/index.js';
import {
  startAgent,
  createAgentActions,
  sendToolResult,
} from './processes/agent/index.js';
import { startDevServer } from './processes/devServer/index.js';
import { ResourceMonitor } from './processes/ResourceMonitor.js';
import { BroadcastBatcher } from './server/server/BroadcastBatcher.js';
import {
  startServer,
  broadcast,
  stopServer,
  setStatus,
  setProxyTarget,
  flushHmr,
} from './server/index.js';
import { ctx, setViewMode, setViewModeCallback } from './server/context.js';
import { handlers } from './server/handlers/index.js';
import { EditorStateManager } from './server/states/EditorStateManager.js';
import { FileTreeManager } from './server/states/FileTreeManager.js';
import { SpecFileTreeManager } from './server/states/SpecFileTreeManager.js';
import { SpecEditorStateManager } from './server/states/SpecEditorStateManager.js';
import { getProjectHasCode } from './server/states/_helpers/getProjectHasCode.js';
import { LspClient } from './lsp/client.js';
import { LspSidecar } from './lsp/sidecar.js';
import { initFilesystem } from './server/handlers/filesystem.js';
import { initShell } from './server/handlers/shell.js';
import { initPty, closeAllPty } from './server/handlers/pty.js';
import { startWatcher, stopWatcher } from './processes/fileWatcher.js';
import {
  initState,
  restoreState,
  saveState,
  stopAutoSave,
  markDirty,
} from './state.js';
import { createLogger, onLog } from './logger.js';
import { SnapshotManager } from './snapshot.js';
import type { AppConfig, WebConfig } from './types.js';

const log = createLogger('cnc');

// ---------------------------------------------------------------------------
// State manager construction
// ---------------------------------------------------------------------------

interface Managers {
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
    const stream =
      entry.level === 'error' || entry.level === 'warn' ? 'stderr' : 'stdout';
    registry.appendLog('system', stream, `[${entry.module}] ${entry.message}`);
  });

  setBootstrapRegistry(registry);
  const processManager = new ProcessManager(registry);

  return {
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
  webConfig: WebConfig | null,
  progress: (step: string, message: string) => void,
  snapshotManager: SnapshotManager,
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
  const devPort = webConfig?.web.devPort ?? 5173;
  const devCommand = webConfig?.web.devCommand ?? 'npm run dev';
  const webDir = webConfig
    ? path.resolve(
        config.workspaceDir,
        path.dirname(
          appConfig.interfaces.find((i) => i.type === 'web')?.path ?? '',
        ),
      )
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
      },
      broadcast,
    },
  );

  // Agent
  progress('agent', 'Starting coding agent...');
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
        if (name === 'setViewMode') {
          setViewMode(input.mode as string);
          sendToolResult(processManager, id, 'ok');
        }
        // promptUser: handled by frontend via promptUserResponse WS action
      },
      onTurnDone: () => snapshotManager.scheduleSnapshot(),
    },
  );

  return { lspClient, lspSidecar };
}

// ---------------------------------------------------------------------------
// File watcher
// ---------------------------------------------------------------------------

function setupFileWatcher(
  config: Config,
  managers: Managers,
  appConfig: AppConfig,
  lspSidecar: LspSidecar,
): void {
  const {
    editorManager,
    specEditorManager,
    fileTreeManager,
    specFileTreeManager,
  } = managers;

  let currentProjectHasCode = ctx.projectHasCode;

  // Shared handler for all file change events — called by both the
  // file watcher (for external/user changes) and the writeFile/deleteFile/
  // renameFile handlers (where watcher events are suppressed).
  function handleFileChanged(
    filePath: string,
    changeType: 'created' | 'modified' | 'deleted',
  ): void {
    broadcast('fileChanged', { path: filePath, changeType });

    if (changeType === 'modified' || changeType === 'created') {
      lspSidecar.onFileChanged(filePath).catch(() => {});

      // Re-read and broadcast manifest when it changes
      if (filePath === 'mindstudio.json') {
        readAppConfig(config.workspaceDir)
          .then((updated) => {
            ctx.appConfig = updated;
            broadcast('manifestChanged', { app: updated });

            // Check if projectHasCode changed
            const newProjectHasCode = getProjectHasCode(updated);
            if (newProjectHasCode !== currentProjectHasCode) {
              currentProjectHasCode = newProjectHasCode;
              ctx.projectHasCode = newProjectHasCode;
              broadcast('projectHasCodeChanged', {
                projectHasCode: newProjectHasCode,
              });
            }
          })
          .catch(() => {});
      }
    }

    if (changeType === 'deleted') {
      editorManager.onFileDeleted(filePath);
      specEditorManager.onFileDeleted(filePath);
    }

    fileTreeManager.onFileChanged(filePath, changeType);

    // Spec file tree updates
    if (filePath.startsWith('src/')) {
      specFileTreeManager.onFileChanged(filePath, changeType);
    }
  }

  // Expose so handlers can call it for suppressed writes
  ctx.onFileChanged = handleFileChanged;

  log.info(`Starting file watcher on ${config.workspaceDir}`);
  startWatcher(config.workspaceDir, handleFileChanged);
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
  const snapshotManager = new SnapshotManager(config.workspaceDir);
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
  await startServer(config.port, config.sandboxToken);
  ctx.batcher = managers.batcher;
  ctx.registry = managers.registry;
  ctx.editorState = managers.editorManager;
  ctx.fileTreeManager = managers.fileTreeManager;
  ctx.specEditorState = managers.specEditorManager;
  ctx.specFileTreeManager = managers.specFileTreeManager;
  ctx.resourceMonitor = managers.resourceMonitor;
  setViewModeCallback((mode) => {
    broadcast('viewModeChanged', { viewMode: mode });
    markDirty();
  });
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
      installLsp(progress),
    ]);

    // 6. Prepare workspace
    await writeTunnelConfig(config);
    await cloneAppRepo(config, progress);
    configureGit(config.workspaceDir);
    await snapshotManager.restore();

    // 7. Read app config
    const appConfig = await readAppConfig(config.workspaceDir);
    const webConfig = await readWebConfig(config.workspaceDir, appConfig);
    ctx.appConfig = appConfig;
    ctx.projectHasCode = getProjectHasCode(appConfig);
    log.info(
      `App: ${appConfig.name} (${appConfig.appId}), projectHasCode: ${ctx.projectHasCode}`,
    );

    // 8. Install dependencies
    await installDependencies(config.workspaceDir, progress);

    // 9. Init handlers
    initFilesystem(config.workspaceDir);
    initShell(config.workspaceDir, managers.registry);
    initPty(config.workspaceDir, managers.registry, managers.batcher);
    ctx.processManager = managers.processManager;
    Object.assign(handlers, createTunnelActions(managers.processManager));
    Object.assign(handlers, createAgentActions(managers.processManager));

    // 10. Restore state
    initState(
      config.workspaceDir,
      managers.registry,
      managers.editorManager,
      managers.specEditorManager,
    );
    await restoreState();

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

    // 11. Build initial file trees
    await managers.fileTreeManager.buildVisibleTree();
    await managers.specFileTreeManager.buildTree();

    // 12. Start services
    const { lspClient, lspSidecar } = await startServices(
      config,
      managers,
      appConfig,
      webConfig,
      progress,
      snapshotManager,
    );
    lspClientRef = lspClient;

    // 13. File watcher
    setupFileWatcher(config, managers, appConfig, lspSidecar);

    // 14. Start periodic snapshots
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
