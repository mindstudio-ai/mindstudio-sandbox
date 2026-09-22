import { ctx } from '../context.ts';
import { createLogger } from '../../logger.ts';
import { sendCommand as sendTunnelCommand } from '../../processes/tunnel/index.ts';
import type { ActionHandler } from './index.ts';

const log = createLogger('handlers');

export const processHandlers: Record<string, ActionHandler> = {
  getProcesses: async () => {
    return { processes: ctx.processManager?.getProcesses() ?? [] };
  },
  restartProcess: async (p) => {
    const { name } = p as { name: string };
    if (!name) {
      throw new Error('Missing "name" parameter');
    }
    if (!ctx.processManager) {
      throw new Error('Process manager not initialized');
    }
    log.info(`Restarting process: ${name}`);

    // The methods worker is forked inside the tunnel, not a ProcessManager
    // process — relay to the tunnel (mirrors the LSP sidecar's mapping).
    if (name === 'methodsWorker') {
      const result = await sendTunnelCommand(
        ctx.processManager,
        'restart-worker',
        {},
        10_000,
      );
      if (result.success === false) {
        throw new Error(
          `Failed to restart methods worker: ${result.error ?? 'unknown error'}`,
        );
      }
      return {};
    }

    // Treat dev server restart as an implicit mindstudio.json change —
    // file watchers don't always pick up changes reliably.
    if (name === 'devServer') {
      ctx.onFileChanged?.('mindstudio.json', 'modified');
    }

    const restarted = await ctx.processManager.restart(name);
    if (!restarted) {
      throw new Error(
        `Unknown process "${name}" — known: devServer, methodsWorker`,
      );
    }
    return {};
  },
};
