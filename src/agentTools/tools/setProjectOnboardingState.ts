import {
  setOnboardingState,
  type ProjectOnboardingState,
} from '../../projectStatus/ProjectStatusManager.js';
import { createLogger } from '../../logger.js';
import type { ExternalToolHandler } from '../types.js';

const log = createLogger('tool:setProjectOnboardingState');

export const setProjectOnboardingStateTool: ExternalToolHandler = {
  handle(id, input, ctx) {
    const state = input.state as ProjectOnboardingState;
    setOnboardingState(state);

    // Side effect: when onboarding finishes, trigger compaction to
    // reclaim context consumed by the onboarding conversation.
    if (state === 'onboardingFinished') {
      ctx.sendAgentCommand('compact', {}, 30_000);
      log.info('Triggered compaction after onboarding finished');
    }

    ctx.broadcast('projectStatusChanged', ctx.getProjectStatus());
    ctx.sendToolResult(id, 'ok');
    return true;
  },
};
