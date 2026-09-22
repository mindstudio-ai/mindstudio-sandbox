import { ctx } from '../context.ts';
import { restartProcess } from '../restartProcess.ts';
import type { ActionHandler } from './index.ts';

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
    await restartProcess(ctx.processManager, name);
    return {};
  },
};
