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

async function main(): Promise<void> {
  // 1. Parse config
  const config = loadConfig();
  console.log(`[cnc] Starting C&C server on port ${config.port}`);
  console.log(`[cnc] Workspace: ${config.workspaceDir}`);

  const processManager = new ProcessManager();

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('[cnc] Shutting down...');
    stopWatcher();
    await processManager.stopAll();
    await stopServer();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  // 2. Start HTTP/WS server immediately (health returns "bootstrapping")
  await startServer(config.port, config.sandboxToken);

  const progress = (step: string, message: string) => {
    console.log(`[cnc] [${step}] ${message}`);
    broadcast('bootstrapProgress', { step, message });
  };

  try {
    // 3. Install tunnel (skip if already in PATH)
    await installTunnel(progress);

    // 4. Write tunnel config
    await writeTunnelConfig(config);

    // 5. Clone app repo (skip if already exists)
    await cloneAppRepo(config, progress);

    // 6. Read app config
    const appConfig = await readAppConfig(config.workspaceDir);
    const webConfig = await readWebConfig(config.workspaceDir, appConfig);
    setAppConfig(appConfig);
    console.log(`[cnc] App: ${appConfig.name} (${appConfig.appId})`);

    const devPort = webConfig?.web.devPort ?? 5173;
    const devCommand = webConfig?.web.devCommand ?? 'npm run dev';

    // 7. Install dependencies
    await installDependencies(config.workspaceDir, progress);

    // Init handlers
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
    }

    // 9. Start tunnel
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
          broadcast('tunnelEvent', tunnelEvent);
          console.log(`[tunnel] ${tunnelEvent.event}`);
          // Capture the tunnel proxy port for reverse proxying
          if (
            tunnelEvent.event === 'session-started' &&
            typeof tunnelEvent.proxyPort === 'number'
          ) {
            setProxyTarget(tunnelEvent.proxyPort);
          }
        } else {
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
    startWatcher(config.workspaceDir, (filePath, changeType) => {
      broadcast('fileChanged', { path: filePath, changeType });
    });

    // 11. Ready
    setStatus('ready');
    progress('ready', 'C&C server is ready');
    console.log('[cnc] Ready');
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Bootstrap failed';
    console.error(`[cnc] Bootstrap error: ${message}`);
    setStatus('error');
    broadcast('bootstrapProgress', { step: 'error', message });
  }
}

main().catch((err) => {
  console.error('[cnc] Fatal:', err);
  process.exit(1);
});
