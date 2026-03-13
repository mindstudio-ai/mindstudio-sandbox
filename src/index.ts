import { loadConfig } from './config.js';
import {
  installTunnel,
  writeTunnelConfig,
  cloneAppRepo,
  readAppConfig,
  readWebConfig,
  installDependencies,
} from './bootstrap.js';
import { ProcessManager } from './process-manager.js';
import {
  startServer,
  broadcast,
  stopServer,
  setStatus,
  setProxyTarget,
  setAppConfig,
} from './ws-server.js';
import { initFilesystem } from './handlers/filesystem.js';
import { initSearch } from './handlers/search.js';
import { initShell } from './handlers/shell.js';
import { startWatcher, stopWatcher } from './file-watcher.js';
import { parseTunnelLine } from './tunnel-events.js';
import path from 'node:path';

const bootStart = Date.now();

function elapsed(): string {
  return `+${Date.now() - bootStart}ms`;
}

async function main(): Promise<void> {
  console.log(`[cnc] ========================================`);
  console.log(`[cnc] C&C Server starting at ${new Date().toISOString()}`);
  console.log(`[cnc] Node ${process.version}, PID ${process.pid}`);
  console.log(`[cnc] cwd: ${process.cwd()}`);
  console.log(`[cnc] ========================================`);

  // 1. Parse config
  console.log(`[cnc] (${elapsed()}) Step 1: Loading config...`);
  const config = loadConfig();
  console.log(`[cnc] (${elapsed()}) Config loaded — port=${config.port}, workspace=${config.workspaceDir}`);

  const processManager = new ProcessManager();

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[cnc] (${elapsed()}) Shutting down...`);
    stopWatcher();
    await processManager.stopAll();
    await stopServer();
    console.log(`[cnc] (${elapsed()}) Shutdown complete`);
    process.exit(0);
  };

  process.on('SIGTERM', () => {
    console.log('[cnc] Received SIGTERM');
    shutdown();
  });
  process.on('SIGINT', () => {
    console.log('[cnc] Received SIGINT');
    shutdown();
  });
  process.on('uncaughtException', (err) => {
    console.error(`[cnc] Uncaught exception: ${err.message}`);
    console.error(err.stack);
  });
  process.on('unhandledRejection', (reason) => {
    console.error(`[cnc] Unhandled rejection: ${reason}`);
  });

  // 2. Start HTTP/WS server immediately (health returns "bootstrapping")
  console.log(`[cnc] (${elapsed()}) Step 2: Starting HTTP/WS server...`);
  await startServer(config.port, config.sandboxToken);
  console.log(`[cnc] (${elapsed()}) Server listening on port ${config.port}`);

  const progress = (step: string, message: string) => {
    console.log(`[cnc] (${elapsed()}) [${step}] ${message}`);
    broadcast('bootstrapProgress', { step, message });
  };

  try {
    // 3. Install tunnel (skip if already in PATH)
    console.log(`[cnc] (${elapsed()}) Step 3: Installing tunnel...`);
    await installTunnel(progress);
    console.log(`[cnc] (${elapsed()}) Tunnel install complete`);

    // 4. Write tunnel config
    console.log(`[cnc] (${elapsed()}) Step 4: Writing tunnel config...`);
    await writeTunnelConfig(config);
    console.log(`[cnc] (${elapsed()}) Tunnel config written`);

    // 5. Clone app repo (skip if already exists)
    console.log(`[cnc] (${elapsed()}) Step 5: Cloning app repo...`);
    await cloneAppRepo(config, progress);
    console.log(`[cnc] (${elapsed()}) App repo ready`);

    // 6. Read app config
    console.log(`[cnc] (${elapsed()}) Step 6: Reading app config...`);
    const appConfig = await readAppConfig(config.workspaceDir);
    const webConfig = await readWebConfig(config.workspaceDir, appConfig);
    setAppConfig(appConfig);
    console.log(`[cnc] (${elapsed()}) App: ${appConfig.name} (${appConfig.appId})`);

    const devPort = webConfig?.web.devPort ?? 5173;
    const devCommand = webConfig?.web.devCommand ?? 'npm run dev';
    console.log(`[cnc] (${elapsed()}) Dev server: port=${devPort}, command="${devCommand}"`);

    // 7. Install dependencies
    console.log(`[cnc] (${elapsed()}) Step 7: Installing dependencies...`);
    await installDependencies(config.workspaceDir, progress);
    console.log(`[cnc] (${elapsed()}) Dependencies installed`);

    // Init handlers
    console.log(`[cnc] (${elapsed()}) Initializing handlers...`);
    initFilesystem(config.workspaceDir);
    initSearch(config.workspaceDir);
    initShell(config.workspaceDir, broadcast);

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
      console.log(`[cnc] (${elapsed()}) Step 8: Starting dev server in ${webDir}...`);
      progress('devServer', `Starting dev server: ${devCommand}`);
      const [cmd, ...args] = devCommand.split(' ');
      processManager.start({
        name: 'devServer',
        command: cmd,
        args,
        cwd: webDir,
        restartOnCrash: true,
        maxRestarts: 5,
        onStdout: (line) => {
          broadcast('processOutput', {
            process: 'devServer',
            stream: 'stdout',
            line,
          });
        },
        onStderr: (line) => {
          broadcast('processOutput', {
            process: 'devServer',
            stream: 'stderr',
            line,
          });
        },
      });
    } else {
      console.log(`[cnc] (${elapsed()}) Step 8: No web interface, skipping dev server`);
    }

    // 9. Start tunnel
    console.log(`[cnc] (${elapsed()}) Step 9: Starting dev tunnel...`);
    progress('tunnel', 'Starting dev tunnel...');
    processManager.start({
      name: 'tunnel',
      command: 'mindstudio-local',
      args: ['--headless', '--port', String(devPort), '--bind', '0.0.0.0'],
      cwd: config.workspaceDir,
      restartOnCrash: true,
      maxRestarts: 5,
      onStdout: (line) => {
        const tunnelEvent = parseTunnelLine(line);
        if (tunnelEvent) {
          console.log(`[cnc] (${elapsed()}) Tunnel event: ${tunnelEvent.event} ${JSON.stringify(tunnelEvent).slice(0, 200)}`);
          broadcast('tunnelEvent', tunnelEvent);
          // Capture the tunnel proxy port for reverse proxying
          if (
            tunnelEvent.event === 'session-started' &&
            typeof tunnelEvent.proxyPort === 'number'
          ) {
            console.log(`[cnc] (${elapsed()}) Tunnel proxy port: ${tunnelEvent.proxyPort}`);
            setProxyTarget(tunnelEvent.proxyPort);
          }
          if (tunnelEvent.event === 'error') {
            console.error(`[cnc] Tunnel error: ${tunnelEvent.message}`);
          }
        } else {
          console.log(`[tunnel:stdout] ${line}`);
          broadcast('processOutput', {
            process: 'tunnel',
            stream: 'stdout',
            line,
          });
        }
      },
      onStderr: (line) => {
        broadcast('processOutput', {
          process: 'tunnel',
          stream: 'stderr',
          line,
        });
      },
    });

    // 10. Start file watcher
    console.log(`[cnc] (${elapsed()}) Step 10: Starting file watcher on ${config.workspaceDir}`);
    startWatcher(config.workspaceDir, (filePath, changeType) => {
      broadcast('fileChanged', { path: filePath, changeType });
    });

    // 11. Ready
    setStatus('ready');
    progress('ready', 'C&C server is ready');
    console.log(`[cnc] (${elapsed()}) ========================================`);
    console.log(`[cnc] (${elapsed()}) READY — Bootstrap complete`);
    console.log(`[cnc] (${elapsed()}) ========================================`);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Bootstrap failed';
    const stack = err instanceof Error ? err.stack : undefined;
    console.error(`[cnc] (${elapsed()}) ========================================`);
    console.error(`[cnc] (${elapsed()}) BOOTSTRAP ERROR: ${message}`);
    if (stack) {
      console.error(stack);
    }
    console.error(`[cnc] (${elapsed()}) ========================================`);
    setStatus('error');
    broadcast('bootstrapProgress', { step: 'error', message });
  }
}

main().catch((err) => {
  console.error('[cnc] Fatal error in main():', err);
  console.error(err.stack);
  process.exit(1);
});
