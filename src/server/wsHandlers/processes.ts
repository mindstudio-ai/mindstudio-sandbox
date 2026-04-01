import { ctx } from '../context.js';
import { createLogger } from '../../logger.js';
import type { ActionHandler } from './index.js';

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

    // Treat dev server restart as an implicit mindstudio.json change —
    // file watchers don't always pick up changes reliably.
    if (name === 'devServer') {
      ctx.onFileChanged?.('mindstudio.json', 'modified');
    }

    await ctx.processManager.restart(name);
    return {};
  },
};
