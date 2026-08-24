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
  unshallowAsync,
  readAppConfig,
  installDependencies,
  linkProdCli,
  setBootstrapRegistry,
} from './bootstrap/index.js';
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
import { initSearch, probeRipgrep } from './server/wsHandlers/search.js';
import { initWorkspaceEdit } from './server/wsHandlers/workspaceEdit.js';
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
import { sendInitialBuildCompleteEmail } from './projectStatus/initialBuildEmail.js';
import {
  initProjectStatus,
  getProjectStatus,
  getOnboardingState,
  setOnboardingState,
} from './projectStatus/ProjectStatusManager.js';
import { readForkSource } from './projectStatus/forkDetection.js';
import type { AppConfig } from './types.js';
import { toolRegistry } from './agentTools/index.js';
import { setupFileWatcher } from './fileWatcher/index.js';
import { cacheVersions } from './server/versionCache.js';

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
  appConfig: AppConfig | null,
  progress: (step: string, message: string) => void,
  snapshotManager: DraftSnapshotManager,
): Promise<{ lspClient: LspClient; lspSidecar: LspSidecar }> {
  const { processManager, registry } = managers;

  // TypeScript language server. A failed init (e.g. TypeScript not resolvable
  // in the environment) must NOT brick the boot — the LSP is a dev-convenience
  // that feeds code intelligence to remy and the editor, not a critical
  // dependency. Degrade gracefully: log, leave the client in its not-running
  // state, and carry on. Mirrors the non-fatal npm-install path above.
  log.info('Starting LSP...');
  const lspClient = new LspClient();
  try {
    await lspClient.start(config.workspaceDir, registry);
  } catch (err) {
    log.error(
      `LSP failed to start; continuing without code intelligence: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  ctx.lspClient = lspClient;

  // LSP HTTP sidecar for remy — started regardless of the init outcome so the
  // configured lsp-url is always live. If the LSP isn't running, requests
  // degrade to "not running" errors rather than connection failures.
  const lspSidecar = new LspSidecar(lspClient);
  await lspSidecar.start(4388);
  lspSidecar.setProcessManager(processManager);
  log.info('LSP sidecar ready on port 4388');

  // Dev server
  const webInterface = appConfig?.interfaces.find((i) => i.type === 'web');
  const webConfig = webInterface?.config as
    | { devCommand?: string; devPort?: number }
    | undefined;
  const devPort = webConfig?.devPort ?? 5173;
  const devCommand = webConfig?.devCommand ?? 'npm run dev';
  // Keyed on the path, not just the entry: `path` is optional in the manifest
  // schema, and path.dirname(undefined) throws the same way readAppConfig's loop
  // did. A web interface that names no config file gives us no directory to run
  // the dev server in, which the `else` below already reports as "no web
  // interface" rather than treating as fatal.
  const webDir = webInterface?.path
    ? path.resolve(config.workspaceDir, path.dirname(webInterface.path))
    : null;

  if (webDir && !ctx.installFailures?.length) {
    progress('devServer', `Starting dev server: ${devCommand}`);
    startDevServer(processManager, { command: devCommand, cwd: webDir });
  } else if (webDir) {
    log.warn(
      'Skipping dev server start because npm install failed — user can fix deps from the terminal and restart manually',
    );
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
      onSandboxBrowserPid: (pid) => {
        if (pid === null) {
          ctx.resourceMonitor?.untrackExternalPid('sandboxBrowser');
        } else {
          ctx.resourceMonitor?.trackExternalPid('sandboxBrowser', pid);
        }
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
    // Genuine first build finished — push _draft (final metadata) then notify
    // youai-api to email the creator. Fire-and-forget; never blocks remy's
    // tool result, never throws.
    onInitialBuildComplete: () => {
      void sendInitialBuildCompleteEmail({
        snapshotManager,
        appId: ctx.appConfig?.appId ?? null,
        apiKey: config.apiKey,
        apiBaseUrl: config.apiBaseUrl,
      });
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
      onEditsFinished: () => {
        flushHmr();
        // Re-read manifest after agent edits — chokidar may miss changes
        // on long-running containers (inotify limits), so this ensures
        // manifestChanged fires when the agent updates interface configs.
        readAppConfig(config.workspaceDir)
          .then((updated) => {
            if (updated) {
              ctx.appConfig = updated;
              broadcast('manifestChanged', { app: updated });
            }
          })
          .catch(() => {});
      },
      onExternalTool: (id, name, input) => {
        const handler = toolRegistry.get(name);
        if (!handler) {
          return false;
        }
        return handler.handle(id, input, toolContext);
      },
      // Explicit snapshot trigger on turn completion — kept alongside the file
      // watcher's trigger so snapshot-on-turn doesn't silently depend on remy
      // happening to rewrite (watched) .remy-stats.json each turn.
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
  ctx.snapshotManager = snapshotManager;
  let shuttingDown = false;
  let bootstrapComplete = false;
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
    if (bootstrapComplete) {
      await snapshotManager.snapshot();
    }
    snapshotManager.stop();
    closeAllPty();
    stopWatcher();
    lspClientRef?.stop();
    await managers.processManager.stopAll();
    managers.registry.closeAllLogStreams();
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
  ctx.workspaceDir = config.workspaceDir;
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

    // 5b. Cache binary versions (non-blocking — best effort)
    await cacheVersions();

    // 6. Prepare workspace
    await writeTunnelConfig(config);
    await cloneAppRepo(config, progress);
    configureGit(config.workspaceDir);
    linkProdCli();
    fsSync.mkdirSync(managers.logsDir, { recursive: true });
    const restoreOutcome = await snapshotManager.restore();
    // Drop any cached log WriteStream FDs — `git restore` does atomic
    // rename which gives restored files (including .logs/*.ndjson) new
    // inodes. Cached FDs from before restore now point to orphan inodes
    // and writes vanish from the filesystem. Closing forces the next
    // appendLog to reopen against the live inode.
    managers.registry.closeAllLogStreams();
    log.info('Reopened log streams after snapshot restore');
    if (restoreOutcome === 'unresolvable') {
      // Refuse to boot in scaffold state. The user's draft either exists
      // and we couldn't fetch/apply it, or the remote is in a state where
      // we can't tell. Either way, proceeding past here would let the user
      // edit on top of the scaffold and silently lose their real work.
      const reason = snapshotManager.getSnapshotStatus().lastError ?? 'unknown';
      const message = `Could not restore your last session: ${reason}`;
      log.error(`${message}. Refusing to boot in scaffold state.`);
      setStatus('error');
      broadcast('bootstrapProgress', { step: 'error', message });
      return; // skip steps 7+: no project status init, no dev server, no agent edits. WS stays up.
    }

    // Now that restore()'s depth-1 fetch has released `.git/shallow.lock`,
    // kick off the background unshallow. Deferred to here (rather than inside
    // configureGit) so the two shallow-mutating fetches never run concurrently.
    // Only on the success path — no point deepening history if we're refusing
    // to boot above.
    unshallowAsync(config.workspaceDir);

    // 7. Init project status (after snapshot restore so file is available)
    initProjectStatus(config.workspaceDir);

    // 7b. Forked-app onboarding stamp. A fork is a main-only git copy of its
    // source, so it carries no _draft — where .project-status.json lives — and
    // would otherwise boot into onboarding. The backend leaves a durable git
    // trailer on main's stamp commit; if we see it and haven't already finished,
    // stamp finished. Gated on state (not the trailer, which lives in history
    // forever) → one-time on first boot, then self-heals (the stamped status
    // rides the next draft snapshot, so later boots restore finished and skip).
    if (getOnboardingState() !== 'onboardingFinished') {
      const forkSource = await readForkSource(config.workspaceDir);
      if (forkSource) {
        log.info(
          `Forked app detected (source ${forkSource}); marking onboarding finished`,
        );
        if (setOnboardingState('onboardingFinished')) {
          broadcast('projectStatusChanged', getProjectStatus());
        }
      }
    }

    // 8. Read app config
    const appConfig = await readAppConfig(config.workspaceDir);
    ctx.appConfig = appConfig;
    if (appConfig) {
      log.info(`App: ${appConfig.name} (${appConfig.appId})`);
    } else {
      log.error(
        'App config missing or corrupted — sandbox will start without it',
      );
    }

    // 9. Install dependencies — non-fatal. installDependencies retries
    // with --legacy-peer-deps internally; if everything still fails we
    // record the failures and boot in degraded mode (no dev server, but
    // terminal/editor/agent all functional so the user can recover).
    const installResult = await installDependencies(
      config.workspaceDir,
      progress,
    );
    if (installResult.failures.length > 0) {
      log.warn(
        `npm install failed in ${installResult.failures.length} directory(ies); booting without dev server`,
      );
      ctx.installFailures = installResult.failures;
    }

    // 10. Init handlers
    initFilesystem(config.workspaceDir);
    initShell(config.workspaceDir, managers.registry);
    initSearch(config.workspaceDir);
    initWorkspaceEdit(config.workspaceDir);
    probeRipgrep().then((ok) => {
      if (!ok) {
        log.error(
          'ripgrep (rg) not found on PATH — workspace search will fail. ' +
            'Install ripgrep in the sandbox runtime.',
        );
      } else {
        log.info('ripgrep available — workspace search ready');
      }
    });
    initPty(config.workspaceDir, managers.registry, managers.batcher);
    ctx.processManager = managers.processManager;
    Object.assign(handlers, createTunnelActions(managers.processManager));
    Object.assign(
      handlers,
      createAgentActions(managers.processManager, {
        onProjectStatusChanged: () => {
          broadcast('projectStatusChanged', getProjectStatus());
        },
        broadcast,
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

    if (managers.editorManager.isEmpty() && appConfig) {
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
    setupFileWatcher(config, managers, lspSidecar);

    // 15. Start the snapshot backstop timer (real changes and agent turns
    // trigger snapshots sooner via the file watcher / onTurnDone).
    snapshotManager.start();

    // Ready
    bootstrapComplete = true;
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
