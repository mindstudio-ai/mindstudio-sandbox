import { ctx } from '../context.ts';
import { sendToolResult } from '../../processes/agent/index.ts';
import {
  setOnboardingState,
  type ProjectOnboardingState,
} from '../../projectStatus/ProjectStatusManager.ts';
import type { ActionHandler } from './index.ts';

export const miscHandlers: Record<string, ActionHandler> = {
  setProjectOnboardingState: async (p) => {
    const { state } = p as { state: string };
    if (setOnboardingState(state as ProjectOnboardingState, true)) {
      ctx.onProjectStatusChanged?.();
    }
    return {};
  },

  externalToolResult: async (p) => {
    const { id, result } = p as { id: string; result: string };
    if (!id) {
      throw new Error('Missing "id" parameter');
    }
    if (!ctx.processManager) {
      throw new Error('Agent not running');
    }
    sendToolResult(ctx.processManager, id, result);
    return {};
  },

  getResources: async () => {
    return ctx.resourceMonitor?.collectNow() ?? {};
  },
};
