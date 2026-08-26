/**
 * Agent WS action handlers — frontend-facing commands for the agent.
 */

import type { ProcessManager } from '../ProcessManager.js';
import {
  sendAgentCommand,
  setLastAbortedTrigger,
  getAgentHistory,
} from './index.js';
import {
  hasPendingUserBlockingTool,
  clearPendingExternalTools,
  startTurn,
  getAgentActivity,
  willQueueMessage,
} from './activity.js';
import {
  getOnboardingState,
  setOnboardingState,
} from '../../projectStatus/ProjectStatusManager.js';
import { createLogger } from '../../logger.js';

const log = createLogger('agent');

type ActionHandler = (params: Record<string, unknown>) => Promise<unknown>;

/** Create WS action handlers for agent commands. */
export function createAgentActions(
  pm: ProcessManager,
  callbacks: {
    onProjectStatusChanged?: () => void;
    broadcast: (event: string, data: Record<string, unknown>) => void;
  },
): Record<string, ActionHandler> {
  const onProjectStatusChanged = callbacks.onProjectStatusChanged;
  const broadcast = callbacks.broadcast;

  return {
    // User sends a message to the agent
    agentMessage: async (p) => {
      const { text, attachments, viewContext, buildModel } = p as {
        text: string;
        attachments?: Array<{
          url: string;
          key?: string;
          extractedTextUrl?: string;
          transcript?: string;
          durationMs?: number;
          isVoice?: boolean;
        }>;
        viewContext?: Record<string, unknown>;
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

      // Any new user message ends the Continue-button window — clear the
      // stored aborted trigger. If the user clicked Continue (re-sending
      // the stored trigger), the re-run will re-populate on its next cancel.
      setLastAbortedTrigger(null, broadcast);

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
        ...(!isAutomated && viewContext ? { viewContext } : {}),
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
      const result = await response;
      // If the user cancels while the build pipeline is mid-flight, drop
      // them out of onboarding entirely so the IDE reverts to normal dev
      // mode rather than getting stuck on a "Building..." screen. Skips
      // the buildComplete reveal — the cancel implies they don't want it.
      if (getOnboardingState() === 'building') {
        if (setOnboardingState('onboardingFinished')) {
          onProjectStatusChanged?.();
        }
      }
      return result;
    },
    // Cancel pending QUEUED user messages only — never touches the in-flight
    // turn (use agentCancel for a hard stop). No `id` cancels all pending user
    // messages; `id` cancels the one whose command.requestId === id. remy
    // protects chain/background items. Response carries cancelledQueued (the
    // removed items); remy also fires queue_changed with the new snapshot.
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
    // Clear conversation — the only "start fresh / new session" path. To
    // start fresh on a specific model, the frontend composes agentClear +
    // agentChangeModels (newSession is gone; clear no longer touches model
    // config, so picks persist across a clear unless changeModels follows).
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
 * Quiesce the agent before a pre-destroy flush: drop queued user messages
 * FIRST (a plain cancel preserves them, and they'd immediately start the next
 * turn — remy's handleCancel removes only chain/background items), then abort
 * the in-flight turn, then await idle. Best-effort and bounded — returns
 * whether the agent actually went idle. Safe when the agent isn't running
 * (sendAgentCommand resolves {success:false} immediately) and when remy is
 * wedged (the short ACK timeouts resolve rather than reject, so two dead
 * round-trips can't eat the whole budget).
 */
export async function quiesceAgent(
  pm: ProcessManager,
  budgetMs: number,
): Promise<boolean> {
  if (pm.getState('agent') !== 'running') {
    return true; // nothing to quiesce
  }
  const deadline = Date.now() + budgetMs;
  await sendAgentCommand(pm, 'cancelQueued', {}, 2_500).response;
  await sendAgentCommand(pm, 'cancel', {}, 2_500).response;
  while (Date.now() < deadline) {
    if (!getAgentActivity().busy) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return !getAgentActivity().busy;
}
