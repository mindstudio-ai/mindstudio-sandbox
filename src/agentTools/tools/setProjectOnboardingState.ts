import {
  setOnboardingState,
  type ProjectOnboardingState,
} from '../../projectStatus/ProjectStatusManager.js';
import type { ExternalToolHandler } from '../types.js';

export const setProjectOnboardingStateTool: ExternalToolHandler = {
  handle(id, input, ctx) {
    const state = input.state as ProjectOnboardingState;
    // Forward-only gate: returns true only on a genuine transition. We use
    // that as the exactly-once trigger for the first-build email — it won't
    // re-fire on resume (state is loaded directly, not via setOnboardingState)
    // or on a re-emit (the gate returns false once already at buildComplete).
    const changed = setOnboardingState(state);
    ctx.broadcast('projectStatusChanged', ctx.getProjectStatus());
    ctx.sendToolResult(id, 'ok');
    if (changed && state === 'buildComplete') {
      ctx.onInitialBuildComplete();
    }
    return true;
  },
};
