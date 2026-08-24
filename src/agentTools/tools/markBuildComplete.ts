import {
  getOnboardingState,
  setOnboardingState,
} from '../../projectStatus/ProjectStatusManager.js';
import type { ExternalToolHandler } from '../types.js';

/**
 * Remy marks the genuine first build as finished → onboarding advances to
 * buildComplete. Hard-gated during intake: the agent must never start (or
 * skip) a build the user hasn't approved via "Start Building" — a chatty
 * reply once got misread as approval and wedged the editor mid-intake.
 */
export const markBuildCompleteTool: ExternalToolHandler = {
  handle(id, input, ctx) {
    if (getOnboardingState() === 'intake') {
      ctx.sendToolResult(
        id,
        'The build hasn\'t started — the user starts it via "Start Building", and you\'ll get an approveInitialPlan message when they do. Stay in intake: keep discussing, and revise the plan with writePlan if they want changes.',
      );
      return true;
    }
    // Forward-only gate: returns true only on a genuine transition. We use
    // that as the exactly-once trigger for the first-build email — it won't
    // re-fire on resume (state is loaded directly, not via setOnboardingState)
    // or on a re-emit (the gate returns false once already at buildComplete).
    const changed = setOnboardingState('buildComplete');
    ctx.broadcast('projectStatusChanged', ctx.getProjectStatus());
    ctx.sendToolResult(id, 'ok');
    if (changed) {
      ctx.onInitialBuildComplete();
    }
    return true;
  },
};
