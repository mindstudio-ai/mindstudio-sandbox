/**
 * Restart one of the box's processes, from either client.
 *
 * The editor (over WS, `wsHandlers/processes.ts`) and remy (over the LSP
 * sidecar's `/restart-process`) each had their own copy of this, and each did
 * half of the dev-server case: the editor's re-read the manifest but never told
 * the proxy the upstream was going down, so the preview showed a connection
 * error instead of the placeholder; remy's told the proxy but skipped the
 * manifest. One operation, both halves, both callers.
 */

import type { ProcessManager } from '../processes/ProcessManager.ts';
import { sendCommand as sendTunnelCommand } from '../processes/tunnel/index.ts';
import { createLogger } from '../logger.ts';
import { refreshAppConfig } from './refreshAppConfig.ts';

const log = createLogger('restart');

export async function restartProcess(
  pm: ProcessManager,
  name: string,
): Promise<void> {
  log.info(`Restarting process: ${name}`);

  // The methods worker is forked inside the tunnel, not a ProcessManager
  // process — relay to the tunnel, which kills it; the next method run
  // respawns it fresh (picking up e.g. a newly installed SDK).
  if (name === 'methodsWorker') {
    const result = await sendTunnelCommand(pm, 'restart-worker', {}, 10_000);
    if (result.success === false) {
      throw new Error(
        `Failed to restart methods worker: ${result.error ?? 'unknown error'}`,
      );
    }
    return;
  }

  if (name === 'devServer') {
    // So the proxy shows its placeholder at once rather than a connection
    // error until its health check notices. Best-effort: that health check is
    // the backstop if the tunnel is between lives.
    const told = await sendTunnelCommand(
      pm,
      'dev-server-restarting',
      {},
      5_000,
    );
    if (told.success === false) {
      log.warn(`Proxy not told about the restart: ${told.error}`);
    }
    // A restart is when someone expects their manifest edits to count, and
    // chokidar has missed changes on long-running containers — so re-read it
    // here rather than trust the watcher saw them.
    await refreshAppConfig();
  }

  const restarted = await pm.restart(name);
  if (!restarted) {
    throw new Error(
      `Unknown process "${name}" — known: devServer, methodsWorker`,
    );
  }
}
