import { execSync } from 'node:child_process';
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
import { ctx } from './server/context.js';
import { handlers } from './server/handlers/index.js';
import { EditorStateManager } from './server/states/EditorStateManager.js';
import { FileTreeManager } from './server/states/FileTreeManager.js';
import { SpecFileTreeManager } from './server/states/SpecFileTreeManager.js';
import { SpecEditorStateManager } from './server/states/SpecEditorStateManager.js';
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
import {
  initProjectStatus,
  getProjectStatus,
  markSpecDirty,
  markCodeDirty,
  clearSyncStatus,
  setOnboardingState,
  type ProjectOnboardingState,
} from './projectStatus.js';
import type { AppConfig } from './types.js';

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
        if (name === 'clearSyncStatus') {
          if (clearSyncStatus()) {
            broadcast('projectStatusChanged', getProjectStatus());
          }
          sendToolResult(processManager, id, 'ok');
          return true;
        } else if (name === 'setProjectOnboardingState') {
          const state = input.state as ProjectOnboardingState;
          setOnboardingState(state);

          // Side effect: when entering initialSpecAuthoring, clear src/app.md
          // if it's still the untouched scaffold version, then open it in the
          // spec editor. This prevents the user from seeing the "hello world"
          // spec before remy writes the real one.
          if (state === 'initialSpecAuthoring') {
            try {
              const diff = execSync('git diff HEAD -- src/app.md', {
                cwd: config.workspaceDir,
                encoding: 'utf-8',
                stdio: ['ignore', 'pipe', 'pipe'],
              });
              if (!diff.trim()) {
                fsSync.writeFileSync(
                  path.join(config.workspaceDir, 'src/app.md'),
                  '',
                  'utf-8',
                );
                log.info(
                  'Cleared scaffold src/app.md (unchanged from initial commit)',
                );
              }
            } catch {
              // File doesn't exist or git fails — either way, nothing to do
            }

            // Broadcast the file change directly (bypassing batcher) so the
            // frontend clears its editor content BEFORE receiving the view
            // transition to spec mode — prevents a flash of stale content.
            broadcast('fileChanged', {
              batch: [{ path: 'src/app.md', changeType: 'modified' }],
            });

            ctx.specEditorState?.openFile('src/app.md', false);
          }

          broadcast('projectStatusChanged', getProjectStatus());
          sendToolResult(processManager, id, 'ok');
          return true;
        } else if (name === 'setProjectMetadata') {
          const {
            name: newName,
            iconUrl,
            openGraphShareImageUrl,
          } = input as {
            name?: string;
            iconUrl?: string;
            openGraphShareImageUrl?: string;
          };
          if (!newName && !iconUrl && !openGraphShareImageUrl) {
            sendToolResult(
              processManager,
              id,
              'error: at least one field required',
            );
            return true;
          }
          try {
            const manifestPath = path.join(
              config.workspaceDir,
              'mindstudio.json',
            );
            const raw = fsSync.readFileSync(manifestPath, 'utf-8');
            const manifest = JSON.parse(raw);
            if (newName != null) {
              manifest.name = newName;
            }
            if (iconUrl != null) {
              manifest.iconUrl = iconUrl;
            }
            if (openGraphShareImageUrl != null) {
              manifest.openGraphShareImageUrl = openGraphShareImageUrl;
            }
            fsSync.writeFileSync(
              manifestPath,
              JSON.stringify(manifest, null, 2) + '\n',
              'utf-8',
            );
            readAppConfig(config.workspaceDir)
              .then((updated) => {
                ctx.appConfig = updated;
                broadcast('manifestChanged', { app: updated });
              })
              .catch(() => {});
            const fields = [
              newName && 'name',
              iconUrl && 'iconUrl',
              openGraphShareImageUrl && 'openGraphShareImageUrl',
            ].filter(Boolean);
            log.info(`Project metadata updated: ${fields.join(', ')}`, {
              toolCallId: id,
            });
          } catch (err) {
            log.error(
              `Failed to update project metadata: ${err instanceof Error ? err.message : err}`,
              { toolCallId: id },
            );
          }
          sendToolResult(processManager, id, 'ok');
          return true;
        } else if (name === 'runScenario') {
          const scenarioId = input.scenarioId as string;
          if (!scenarioId) {
            sendToolResult(processManager, id, 'error: missing scenarioId');
            return true;
          }
          log.info('Agent running scenario', { toolCallId: id, scenarioId });
          sendTunnelCommand(
            processManager,
            'run-scenario',
            { scenarioId },
            30_000,
          ).then((result) =>
            sendToolResult(processManager, id, JSON.stringify(result)),
          );
          return true;
        } else if (name === 'runMethod') {
          const method = input.method as string;
          if (!method) {
            sendToolResult(
              processManager,
              id,
              JSON.stringify({
                success: false,
                error: 'missing method',
              }),
            );
            return true;
          }
          const methodInput = (input.input as Record<string, unknown>) ?? {};
          log.info('Agent running method', { toolCallId: id, method });
          sendTunnelCommand(
            processManager,
            'run-method',
            { method, input: methodInput },
            30_000,
          ).then((result) =>
            sendToolResult(processManager, id, JSON.stringify(result)),
          );
          return true;
        } else if (name === 'browserCommand') {
          const steps = (input.steps as unknown[]) ?? [];
          log.info('Agent running browser command', {
            toolCallId: id,
            steps: steps.length,
          });
          sendTunnelCommand(processManager, 'browser', { steps }, 120_000).then(
            (result) =>
              sendToolResult(processManager, id, JSON.stringify(result)),
          );
          return true;
        }
        // Not handled server-side — frontend handles via externalToolResult WS action
        return false;
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
    batcher,
    editorManager,
    specEditorManager,
    fileTreeManager,
    specFileTreeManager,
  } = managers;

  // Shared handler for all file change events — called by both the
  // file watcher (for external/user changes) and the writeFile/deleteFile/
  // renameFile handlers (where watcher events are suppressed).
  function handleFileChanged(
    filePath: string,
    changeType: 'created' | 'modified' | 'deleted',
  ): void {
    batcher.push('fileChanged', { path: filePath, changeType });

    if (changeType === 'modified' || changeType === 'created') {
      lspSidecar.onFileChanged(filePath).catch(() => {});

      // Re-read and broadcast app config when manifest or any interface
      // config file changes (e.g. web.json, cron.json).
      const isInterfaceConfig = ctx.appConfig?.interfaces.some(
        (i) => i.path === filePath,
      );
      if (filePath === 'mindstudio.json' || isInterfaceConfig) {
        readAppConfig(config.workspaceDir)
          .then((updated) => {
            ctx.appConfig = updated;
            broadcast('manifestChanged', { app: updated });
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

  // Track user saves for sync status
  ctx.onUserSave = (filePath: string) => {
    if (filePath.startsWith('src/')) {
      if (markSpecDirty()) {
        broadcast('projectStatusChanged', getProjectStatus());
      }
    } else if (filePath.startsWith('dist/')) {
      if (markCodeDirty()) {
        broadcast('projectStatusChanged', getProjectStatus());
      }
    }
  };

  // Broadcast project status changes (onboarding state set by user)
  ctx.onProjectStatusChanged = () => {
    broadcast('projectStatusChanged', getProjectStatus());
  };

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
