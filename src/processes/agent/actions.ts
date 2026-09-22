/**
 * Agent WS action handlers — frontend-facing commands for the agent.
 */

import type { ProcessManager } from '../ProcessManager.ts';
import { sendAgentCommand, getAgentHistory } from './index.ts';
import {
  hasPendingUserBlockingTool,
  clearPendingExternalTools,
  startTurn,
  getAgentActivity,
  willQueueMessage,
} from './activity.ts';
import {
  getOnboardingState,
  setOnboardingState,
} from '../../projectStatus/ProjectStatusManager.ts';
import { createLogger } from '../../logger.ts';

const log = createLogger('agent');

type ActionHandler = (params: Record<string, unknown>) => Promise<unknown>;

/** Create WS action handlers for agent commands. */
export function createAgentActions(
  pm: ProcessManager,
  callbacks: {
    onProjectStatusChanged?: () => void;
  },
): Record<string, ActionHandler> {
  const onProjectStatusChanged = callbacks.onProjectStatusChanged;

  return {
    // User sends a message to the agent
    agentMessage: async (p) => {
      const { text, attachments, buildModel } = p as {
        text: string;
        attachments?: Array<{
          url: string;
          key?: string;
          extractedTextUrl?: string;
          transcript?: string;
          durationMs?: number;
          isVoice?: boolean;
        }>;
        /**
         * Optional model to execute an approved plan on ("Build with X").
         * Forwarded verbatim — remy scopes it (honored only on the
         * approvePlan message) and validates it against allowedModelsByType,
         * with an independent server-side gate. Validating here too would
         * mean tracking model state the sandbox doesn't own.
         */
        buildModel?: string;
      };
      log.info(`Sending message: ${text.slice(0, 100)}...`);

      // If remy is blocked on a *user-blocking* external tool (a promptUser
      // form, a plan approval, a destructive-action confirm) that will never
      // resolve on its own, cancel the current turn first so remy can accept
      // the new message. Autonomous in-flight tools (QA/browser sub-agents,
      // design expert, runMethod, …) are NOT cancelled — remy queues the
      // message and runs it when the turn completes.
      if (hasPendingUserBlockingTool()) {
        log.info(
          'Cancelling user-blocking external tool before sending message',
        );
        clearPendingExternalTools();
        const { response: cancelResponse } = sendAgentCommand(
          pm,
          'cancel',
          {},
          5_000,
        );
        await cancelResponse;
      }

      const isAutomated = text.startsWith('@@automated::');

      // Advance onboarding to 'building' when the user approves the initial
      // plan. This is the ONLY path into 'building': the agent has no tool
      // for it (markBuildComplete only ever sets buildComplete, and is
      // refused during intake).
      if (text.startsWith('@@automated::approveInitialPlan@@')) {
        if (setOnboardingState('building')) {
          onProjectStatusChanged?.();
        }
      }

      // Snapshot now — after any pending-external-tool cancel above has
      // settled — to decide queue vs run. When remy will queue the message, its
      // terminal completed won't arrive until it drains and runs, so we don't
      // await it; we ack immediately and let the FE confirm via the next
      // agentQueueChanged (match requestId) and the eventual agentCompleted.
      // This asks the broader question, not "is the agent busy": a queue
      // holding only held items reports idle, but this send still folds in
      // behind them.
      const busy = willQueueMessage();

      const { requestId, response } = sendAgentCommand(pm, 'message', {
        text,
        onboardingState: getOnboardingState(),
        ...(attachments?.length ? { attachments } : {}),
        // Omitted entirely when absent, so the default-model payload stays
        // byte-identical to what we sent before this existed.
        ...(buildModel ? { buildModel } : {}),
      });

      if (busy) {
        // Queued mid-turn. Don't startTurn (a turn is already active) and don't
        // await the far-off completed — turn_started tracks it when it runs.
        return { success: true, requestId, queued: true };
      }

      startTurn(requestId);
      return await response;
    },
    // User cancel in-progress agent message
    agentCancel: async () => {
      const { response } = sendAgentCommand(pm, 'cancel', {}, 5_000);
      const result = (await response) as { pausedPipeline?: boolean };
      // A Stop that PAUSED a build pipeline stays in 'building': the remaining
      // steps are still in remy's queue, held, and the user's next message
      // resumes them. Unlocking the editor here would reveal a half-built app
      // and strand the real reveal — postBuildPolish's markBuildComplete —
      // behind an onboarding that had already ended.
      //
      // When nothing was paused, the old escape hatch stands: a cancel during a
      // build that can't be resumed (a one-off action, or an older remy that
      // still destroys the chain) would otherwise strand 'building' with no
      // affordance at all. The user's other exits are unaffected — the queue
      // card's Discard, /finish, and the locked-tab dialog's Unlock Editor.
      if (
        result?.pausedPipeline !== true &&
        getOnboardingState() === 'building'
      ) {
        if (setOnboardingState('onboardingFinished')) {
          onProjectStatusChanged?.();
        }
      }
      return result;
    },
    // Cancel pending QUEUED messages — never touches the in-flight turn (use
    // agentCancel for a hard stop). No `id` cancels all pending user messages;
    // `id` cancels the one whose command.requestId === id, which is also the
    // only way to discard a held chain step (a build pipeline a Stop paused —
    // that's the queue card's Discard). remy protects live pipeline work:
    // deliverable chain items and background results are never removable.
    // Response carries cancelledQueued (the removed items); remy also fires
    // queue_changed with the new snapshot.
    agentCancelQueued: async (p) => {
      const { id } = p as { id?: string };
      const { response } = sendAgentCommand(
        pm,
        'cancelQueued',
        id ? { id } : {},
        5_000,
      );
      return await response;
    },
    // Promote a queued user message to ASAP delivery (remy injects it into
    // the running turn at its next tool boundary) or demote it back to
    // after-turn. `id` is the queued item's command.requestId. Only plain
    // user messages qualify — remy rejects automated/chain/background items
    // (and items already consumed) with success:false. The updated snapshot
    // arrives via agentQueueChanged.
    agentSetQueuedDelivery: async (p) => {
      const { id, delivery } = p as {
        id: string;
        delivery: 'asap' | 'afterTurn';
      };
      const { response } = sendAgentCommand(
        pm,
        'setQueuedDelivery',
        { id, delivery },
        5_000,
      );
      return await response;
    },
    // Paginated history fetch — frontend uses this for scroll-up to load
    // older messages without reconnecting. `before` and `limit` map to
    // remy's `get_history` pagination contract. The initial page is
    // included in the init frame; this action loads additional pages.
    agentGetHistory: async (p) => {
      const { before, limit } = p as { before?: number; limit?: number };
      return await getAgentHistory(pm, {
        ...(typeof before === 'number' ? { before } : {}),
        ...(typeof limit === 'number' ? { limit } : {}),
      });
    },
    // Clear conversation — the only "start fresh / new session" path.
    // Clear does not touch model config: the user's picks persist across a
    // clear, and the session_cleared payload echoes them back. Starting
    // fresh on a *different* model means composing agentClear +
    // agentChangeModels.
    agentClear: async () => {
      const { response } = sendAgentCommand(pm, 'clear', {}, 5_000);
      return await response;
    },
    // Change per-agent model picks WITHOUT clearing history. Takes effect on
    // the next turn (models resolve live per call); the conversation is
    // preserved (use agentClear to start fresh). `models` is a sparse map
    // keyed by agent identifier (parent, visualDesignExpert, ...) —
    // omit/empty resets every agent to server defaults. Pass-through; remy
    // validates the IDs and surfaces an `invalid_model_override` error event
    // (broadcast as agentError) for non-allow-listed picks.
    agentChangeModels: async (p) => {
      const { models } = p as { models?: Record<string, string> };
      const params: Record<string, unknown> = {};
      if (models && typeof models === 'object') {
        params.models = models;
      }
      const { response } = sendAgentCommand(pm, 'changeModels', params, 5_000);
      const result = await response;
      // Running-turn guard: remy rejects changeModels mid-turn with
      // completed { success:false, error:"cannot change models while a turn
      // is running" }. Surface a clearer instruction; pass every other
      // failure (e.g. invalid_model_override) through verbatim.
      if (
        result.success === false &&
        typeof result.error === 'string' &&
        /turn is running/i.test(result.error)
      ) {
        return {
          success: false,
          error: 'Finish or cancel the current turn first.',
        };
      }
      return result;
    },
    // Compact conversation
    agentCompact: async () => {
      const { response } = sendAgentCommand(pm, 'compact', {}, 30_000);
      return await response;
    },
    // Stop a tool
    agentStopTool: async (p) => {
      const { id, mode } = p as { id: string; mode?: 'graceful' | 'hard' };
      log.info(`Stopping tool ${id} (mode=${mode ?? 'hard'})`, {
        toolCallId: id,
      });
      const { response } = sendAgentCommand(
        pm,
        'stop_tool',
        { id, mode: mode ?? 'hard' },
        5_000,
      );
      return await response;
    },
    // Restart a tool
    agentRestartTool: async (p) => {
      const { id, input } = p as {
        id: string;
        input?: Record<string, unknown>;
      };
      log.info(`Restarting tool ${id}`, { toolCallId: id });
      const { response } = sendAgentCommand(
        pm,
        'restart_tool',
        { id, ...(input ? { input } : {}) },
        5_000,
      );
      return await response;
    },
  };
}

/**
 * Quiesce the agent before a pre-destroy flush: abort the in-flight turn, then
 * await idle, so the tar isn't of a workspace the agent is halfway through
 * writing. Best-effort and bounded — returns whether the agent actually went
 * idle. Safe when the agent isn't running (sendAgentCommand resolves
 * {success:false} immediately) and when remy is wedged (the short ACK timeout
 * resolves rather than rejects, so a dead round-trip can't eat the budget).
 *
 * `reason: 'shutdown'` is what keeps this from reading as a user pressing Stop.
 * remy pauses the queue either way — nothing may start a turn while we're
 * tarring — but a shutdown tags its own pipeline steps so the next boot resumes
 * them, instead of stranding a build behind a message the user has no reason to
 * send. They never stopped it; we did.
 *
 * No `cancelQueued` first. That used to be here because a plain cancel let the
 * user's queued messages start the next turn immediately — untrue since remy
 * gained `held`. All it does now is permanently delete messages someone typed,
 * before the snapshot, so they aren't even on disk for the next boot.
 */
export async function quiesceAgent(
  pm: ProcessManager,
  budgetMs: number,
): Promise<boolean> {
  if (pm.getState('agent') !== 'running') {
    return true; // nothing to quiesce
  }
  const deadline = Date.now() + budgetMs;
  await sendAgentCommand(pm, 'cancel', { reason: 'shutdown' }, 2_500).response;
  while (Date.now() < deadline) {
    if (!getAgentActivity().busy) {
      return true;
    }
    // The agent dying mid-poll is idle, whatever the last queue snapshot said.
    // Derived busy counts deliverable queue items, so a stale snapshot from a
    // process that has already exited would otherwise spin out the whole
    // budget and report not-idle — which costs finalizeWorkspace its settle.
    if (pm.getState('agent') !== 'running') {
      return true;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return !getAgentActivity().busy;
}
