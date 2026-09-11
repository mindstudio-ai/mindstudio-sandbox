#!/usr/bin/env node
// The shebang is what makes the `remy-sandbox` bin work: npm symlinks the bin name straight at this
// emitted file and sets the executable bit, so without an interpreter line the kernel hands it to
// /bin/sh, which fails on the first `import`. tsc preserves a leading shebang into the emit.
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
  refreshGitRemote,
  configureGit,
  unshallowAsync,
  readAppConfig,
  installDependencies,
  ensureProdCli,
  setBootstrapRegistry,
} from './bootstrap/index.js';
import { ProcessRegistry } from './processes/ProcessRegistry.js';
import { ProcessManager } from './processes/ProcessManager.js';
import {
  startTunnel,
  createTunnelActions,
  failPendingCommands,
  sendCommand as sendTunnelCommand,
} from './processes/tunnel/index.js';
import {
  startAgent,
  sendAgentCommand,
  sendToolResult,
} from './processes/agent/index.js';
import { createAgentActions, quiesceAgent } from './processes/agent/actions.js';
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
  closeLspClients,
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
import { bootPhase } from './bootProgress.js';
import { HomeSnapshotManager } from './projectStatus/HomeSnapshotManager.js';
import { restoreFromLegacyDraft } from './projectStatus/legacyDraftRestore.js';
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

// Shutdown flush budgets. SIGTERM is the one flush path: Kubernetes delivers it on every stop (the
// platform's, the reaper's, a node drain) and the pod's terminationGracePeriodSeconds bounds the
// whole shutdown, so these must sum to well under it.
//
// INJECTED, not decided here. The grace period that bounds them belongs to whoever writes the pod
// spec, so the budgets live beside it in CFES's `sandboxLifecycle.ts` (`dev.shutdown`, delivered by
// `devLifecycleEnv()`). A box that keeps its own copy is a box whose margin can silently vanish
// when the grace period moves — which is exactly what had happened: the comment here claimed a 60s
// snapshot budget against an actual 75s, leaving ~3s of headroom rather than ~18s.
//
// The fallbacks are the shipped values, so a box on an image older than the injection still behaves
// exactly as it did.
const envMs = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const SHUTDOWN_QUIESCE_BUDGET_MS = envMs('SHUTDOWN_QUIESCE_BUDGET_MS', 8_000);
// remy emits its cancel terminal BEFORE the (sync) session-file write — give the write a beat to
// land once the agent reports idle.
const SHUTDOWN_SETTLE_MS = envMs('SHUTDOWN_SETTLE_MS', 750);
// The whole quiesce-settle-tar-upload sequence. A multi-GB home on a busy box needs most of this.
const SHUTDOWN_SNAPSHOT_BUDGET_MS = envMs(
  'SHUTDOWN_SNAPSHOT_BUDGET_MS',
  75_000,
);
// Closing the server waits for every connection to drain, and a WS peer that never answers its
// close frame (a laptop that shut its lid mid-session) holds its socket for the `ws` library's own
// 30s timeout. The snapshot has already landed by then, so waiting protects nothing.
const SHUTDOWN_SERVER_CLOSE_BUDGET_MS = envMs(
  'SHUTDOWN_SERVER_CLOSE_BUDGET_MS',
  3_000,
);

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
      // Nothing will answer a command sent to a tunnel that just died — fail
      // the callers now instead of after their full timeout.
      if (
        event.name === 'tunnel' &&
        event.prevState === 'running' &&
        event.state !== 'running'
      ) {
        failPendingCommands(`tunnel ${event.state}`);
      }
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
  snapshotManager: HomeSnapshotManager,
): Promise<{ lspClient: LspClient; lspSidecar: LspSidecar }> {
  const { processManager, registry } = managers;

  // TypeScript language server. A failed init (e.g. TypeScript not resolvable
  // in the environment) must NOT brick the boot — the LSP is a dev-convenience
  // that feeds code intelligence to remy and the editor, not a critical
  // dependency. Degrade gracefully: log, leave the client in its not-running
  // state, and carry on. Mirrors the non-fatal npm-install path above.
  log.info('Starting LSP...');
  const lspClient = new LspClient();
  // A relaunched server has no documents open; bounce the Monaco clients so
  // they reconnect and re-announce theirs.
  lspClient.onRelaunched = () =>
    closeLspClients(1012, 'Language server restarted');
  // NOT awaited. The `initialize` round trip is ~400ms and NOTHING below needs it: the agent needs
  // the SIDECAR on 4388, which comes up either way (see its comment), and the dev server and tunnel
  // need neither. Awaiting it delayed the spawn of all three, and since `ready` is set once this
  // function returns, it delayed the editor too — so the cost was ~400ms on top of Vite's own
  // multi-second boot and remy's own startup, rather than overlapped with them.
  //
  // The trade is that an LSP request in that window answers "not running" instead of blocking. That
  // is the same degraded mode a failed init already produces, deliberately: code intelligence is a
  // convenience here, not a boot dependency.
  void lspClient.start(config.workspaceDir, registry).catch((err) => {
    log.error(
      `LSP failed to start; continuing without code intelligence: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  });
  ctx.lspClient = lspClient;

  // LSP HTTP sidecar for remy — started regardless of the init outcome so the
  // configured lsp-url is always live. If the LSP isn't running, requests
  // degrade to "not running" errors rather than connection failures.
  //
  // This one IS awaited: remy is spawned below with `--lsp-url` pointing here, so the port has to
  // be bound before it can ask. Milliseconds, and it does not wait on the handshake above.
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
    // Genuine first build finished — snapshot (the commit carries the final
    // metadata) then notify youai-api to email the creator. Fire-and-forget;
    // never blocks remy's tool result, never throws.
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
  // A `BranchWatcher` sat here, polling HEAD and reporting it upstream so the platform's record,
  // the dev release and the next snapshot all followed a checkout. Nothing keys on the branch now,
  // so a checkout is local to this box and the tunnel keeps its own dev release across one.
  const snapshotManager = new HomeSnapshotManager({
    homeDir: config.homeDir,
    workspaceDir: config.workspaceDir,
    appId: config.appId,
    sessionId: config.sessionId,
    apiBaseUrl: config.apiBaseUrl,
    apiKey: config.apiKey,
    // Health transitions (uploads failing / recovered / fenced) go straight to
    // editor clients so "your work isn't backed up" is visible, not a counter
    // nobody polls.
    onStatusChange: () =>
      broadcast('snapshotStatusChanged', {
        snapshot: snapshotManager.getSnapshotStatus(),
      }),
  });
  ctx.snapshotManager = snapshotManager;

  // The one "settle and save" routine — see ctx.finalizeWorkspace. Quiesce so the tar isn't of a
  // workspace the agent is halfway through writing, give remy's final (synchronous) session write
  // a beat to land, then snapshot. Called by SIGTERM below and by the platform's `/flush`.
  const finalizeWorkspace = async () => {
    // 'bootstrapping': the restore may not have run, so a snapshot could upload scaffold state
    // over the real one. 'error': the restore was unresolvable, so uploading would overwrite good
    // work. Either way there is nothing of the user's here to save.
    if (ctx.status !== 'ready') {
      return 'not_ready' as const;
    }
    const quiesced = await quiesceAgent(
      managers.processManager,
      SHUTDOWN_QUIESCE_BUDGET_MS,
    );
    if (quiesced) {
      await new Promise((r) => setTimeout(r, SHUTDOWN_SETTLE_MS));
    }
    return snapshotManager.flushNow();
  };
  ctx.finalizeWorkspace = finalizeWorkspace;

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    log.info('Shutting down...');
    // FIRST, before the snapshot below and before anything else that takes time. SIGTERM reaches
    // every process in the container, so the agent, the dev server and the language server are
    // already exiting by the time this line runs — and a supervisor that reads those as crashes
    // acts on them mid-shutdown: procman's `critical` guard turns the agent's clean exit into
    // `process.exit(1)`, which kills this process before the snapshot below can finish.
    managers.processManager.beginShutdown();
    lspClientRef?.stop();
    managers.registry.setState('system', 'stopped');
    managers.resourceMonitor.stop();
    managers.batcher.stop();
    stopAutoSave();
    await saveState();
    // The BACKSTOP save, for a stop the platform didn't initiate (node drain, eviction, the
    // kubelet's deadline). A platform stop calls `/flush` first and waits for the answer, so it
    // never has to trust that this ran — and if it did already run, `flushNow` finds nothing
    // changed and returns in milliseconds. Bounded so a hung upload can't hold the rest of the
    // shutdown until SIGKILL.
    const outcome = await Promise.race([
      finalizeWorkspace().catch((err) => {
        log.error(`Shutdown snapshot threw: ${err}`);
        return 'failed' as const;
      }),
      new Promise<'timeout'>((r) =>
        setTimeout(() => r('timeout'), SHUTDOWN_SNAPSHOT_BUDGET_MS),
      ),
    ]);
    log.info(`Shutdown snapshot: ${outcome}`);
    snapshotManager.stop();
    closeAllPty();
    stopWatcher();
    await managers.processManager.stopAll();
    managers.registry.closeAllLogStreams();
    await Promise.race([
      stopServer(),
      new Promise((r) => setTimeout(r, SHUTDOWN_SERVER_CLOSE_BUDGET_MS)),
    ]);
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
  // The only way to tell from outside whether the budgets were injected or fell back to the
  // shipped defaults — and the sum is the number that has to stay under the pod's grace period.
  log.info(
    `Shutdown budgets: quiesce=${SHUTDOWN_QUIESCE_BUDGET_MS}ms settle=${SHUTDOWN_SETTLE_MS}ms ` +
      `snapshot=${SHUTDOWN_SNAPSHOT_BUDGET_MS}ms close=${SHUTDOWN_SERVER_CLOSE_BUDGET_MS}ms ` +
      `(total ${SHUTDOWN_QUIESCE_BUDGET_MS + SHUTDOWN_SETTLE_MS + SHUTDOWN_SNAPSHOT_BUDGET_MS + SHUTDOWN_SERVER_CLOSE_BUDGET_MS}ms)`,
  );

  const progress = (step: string, message: string) => {
    log.info(`[${step}] ${message}`);
    broadcast('bootstrapProgress', { step, message });
  };

  // The control server is up, which is the first thing this process can honestly claim. CFES has
  // already reported everything before it (schedule, image, VM) from outside.
  bootPhase(`Control server listening on ${config.port}`, {
    phase: 'server',
    state: 'done',
    detail: `Node ${process.version}`,
  });

  try {
    // 5. Install binaries. NOT installAgentSdk — see step 6b: it settles the global agent SDK
    // against the home directory, so it has to run on the home directory the box ends up with.
    bootPhase('Preparing tooling', { phase: 'tooling', state: 'active' });
    const toolingStart = Date.now();
    const tooling = await Promise.all([
      installTunnel(progress),
      installAgent(progress),
      installLsp(progress),
    ]);
    // `cached` only when every one of the three came from the image. Any install that actually ran
    // is a slower boot for a reason worth showing, so it must not be reported as free.
    const toolingFromImage = tooling.every((t) => t?.fromImage !== false);
    bootPhase(
      toolingFromImage
        ? 'Tooling already in the image'
        : 'Tooling installed at boot',
      {
        phase: 'tooling',
        state: 'done',
        cached: toolingFromImage,
        detail: toolingFromImage
          ? '3 of 3 from the image'
          : `Installed in ${Date.now() - toolingStart}ms`,
      },
    );

    // 6. Prepare home. Refuse to boot in scaffold state whenever the user's
    // work may exist but could not be brought back: proceeding would let them
    // edit on top of the scaffold and the next snapshot would overwrite it.
    const refuseToBoot = (reason: string) => {
      const message = `Could not restore your last session: ${reason}`;
      log.error(`${message}. Refusing to boot in scaffold state.`);
      setStatus('error');
      broadcast('bootstrapProgress', { step: 'error', message });
      bootPhase(message, { phase: 'restore', state: 'done', detail: reason });
    };
    progress('restore', 'Restoring workspace...');
    // `prepareHome` emits this phase's own counters as it transfers and unpacks.
    bootPhase('Restoring your workspace', {
      phase: 'restore',
      state: 'active',
    });
    const restoreOutcome = await snapshotManager.prepareHome();
    if (restoreOutcome === 'unresolvable') {
      refuseToBoot(snapshotManager.getSnapshotStatus().lastError ?? 'unknown');
      return; // skip steps 7+: no project status init, no dev server, no agent edits. WS stays up.
    }
    if (restoreOutcome === 'no_snapshot') {
      // First boot since the app last ran on the `_draft` branch, or a brand
      // new app: clone, then try the legacy branch. A restored draft is
      // uploaded on the first snapshot cycle so the app has a snapshot from
      // here on.
      await cloneAppRepo(config, progress);
      const legacy = await restoreFromLegacyDraft(config.workspaceDir);
      if (legacy.outcome === 'unresolvable') {
        refuseToBoot(legacy.error ?? 'unknown');
        return;
      }
      if (legacy.outcome === 'restored') {
        snapshotManager.forceNextUpload();
      }
      // After the legacy fetch has released `.git/shallow.lock`: the two
      // shallow-mutating fetches must not run concurrently.
      unshallowAsync(config.workspaceDir);
    } else {
      // A restored (or resumed) workspace carries the previous session's git
      // credential, which the platform has since revoked.
      refreshGitRemote(config);
    }
    await writeTunnelConfig(config);
    configureGit(config.workspaceDir);
    ensureProdCli();
    fsSync.mkdirSync(managers.logsDir, { recursive: true });
    // Drop any cached log WriteStream FDs — the restore replaced files
    // (including .logs/*.ndjson) with new inodes, so FDs opened before it
    // point at orphans and writes vanish. Closing forces the next appendLog
    // to reopen against the live inode.
    managers.registry.closeAllLogStreams();
    snapshotManager.markBooted();

    // The restore's own counters have stopped by here. `resumed` is an in-place server restart on a
    // box whose filesystem never went away, and saying "restored" for it would be a small lie in
    // the one display whose job is to be believable.
    bootPhase(
      restoreOutcome === 'resumed'
        ? 'Session resumed in place'
        : restoreOutcome === 'restored'
          ? 'Workspace restored'
          : 'Fresh workspace prepared',
      {
        phase: 'restore',
        state: 'done',
        cached: restoreOutcome === 'restored' || restoreOutcome === 'resumed',
        detail: snapshotManager.getRestoreSummary() ?? undefined,
      },
    );

    // 6b. Settle the global agent SDK, which remy shells out to as a bash tool and which must
    // therefore always be the image's. This runs HERE rather than with the other installers because
    // it reasons about `~/.npm-global` — and until the restore has landed, that is the wrong home
    // directory: an eviction before it would be undone by the untar seconds later.
    await installAgentSdk(progress);

    // 6c. Record installed versions for `/status`. After the restore AND after the step above, so
    // it describes the tooling the box will actually run. Cheap now (a package.json read each).
    await cacheVersions();

    // 7. Init project status (after the restore so the file is available)
    initProjectStatus(config.workspaceDir);

    // 7b. Forked-app onboarding stamp. A fork is a main-only git copy of its
    // source, so it carries no workspace snapshot — where .project-status.json
    // lives — and would otherwise boot into onboarding. The backend leaves a
    // durable git trailer on main's stamp commit; if we see it and haven't
    // already finished, stamp finished. Gated on state (not the trailer, which
    // lives in history forever) → one-time on first boot, then self-heals (the
    // stamped status rides the next snapshot, so later boots restore finished
    // and skip).
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
    bootPhase('Checking dependencies', { phase: 'deps', state: 'active' });
    const depsStart = Date.now();
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
    // Snapshots no longer carry `node_modules` (see SNAPSHOT_EXCLUDES), so this is a real install
    // and the phase that most of a boot now sits in. Report the count and the time and nothing else:
    // whether the tree came from the image's baked copy, a restored older snapshot or the registry
    // is a fact about our provisioning, and the user's question is only whether their project is
    // ready. The npm summary that answers OUR question is logged per directory by installDependencies.
    bootPhase(
      installResult.failures.length > 0
        ? `Dependencies incomplete in ${installResult.failures.length} directory(ies)`
        : 'Dependencies ready',
      {
        phase: 'deps',
        state: 'done',
        detail:
          installResult.failures.length > 0
            ? 'Booting without a dev server'
            : `${installResult.installedDirs} director${
                installResult.installedDirs === 1 ? 'y' : 'ies'
              } in ${Date.now() - depsStart}ms`,
      },
    );

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
    bootPhase('Starting services', { phase: 'services', state: 'active' });
    const servicesStart = Date.now();
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

    // 15. Start the snapshot interval (plus the SIGTERM flush in shutdown).
    snapshotManager.start();

    bootPhase('Services started', {
      phase: 'services',
      state: 'done',
      detail: `Dev server, agent, tunnel and language server in ${
        Date.now() - servicesStart
      }ms`,
    });

    // Ready
    setStatus('ready');
    progress('ready', 'C&C server is ready');
    bootPhase('Ready', { phase: 'ready', state: 'done' });
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
