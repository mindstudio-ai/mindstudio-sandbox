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
  hasPendingExternalTools,
  clearPendingExternalTools,
  startTurn,
  getAgentActivity,
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
      const { text, attachments, viewContext } = p as {
        text: string;
        attachments?: Array<{
          url: string;
          extractedTextUrl?: string;
          transcript?: string;
          durationMs?: number;
          isVoice?: boolean;
        }>;
        viewContext?: Record<string, unknown>;
      };
      log.info(`Sending message: ${text.slice(0, 100)}...`);

      // If remy is blocked waiting for an external tool result (e.g., a
      // promptUser that was never answered), cancel the current turn first
      // so remy can accept the new message.
      if (hasPendingExternalTools()) {
        log.info('Cancelling pending external tools before sending message');
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

      // User-typed messages are rejected while the agent is busy. Automated
      // messages (button clicks, remy chain steps) are allowed to queue —
      // we don't expose user queueing as a product feature yet.
      if (!isAutomated && getAgentActivity().busy) {
        return {
          success: false,
          error: 'Agent is busy — please wait for the current turn to finish',
        };
      }

      // Any new user message ends the Continue-button window — clear the
      // stored aborted trigger. If the user clicked Continue (re-sending
      // the stored trigger), the re-run will re-populate on its next cancel.
      setLastAbortedTrigger(null, broadcast);

      // Advance onboarding to 'building' when the user approves the initial
      // plan. Remy also calls setProjectOnboardingState('building') at the
      // start of its pipeline — the forward-only gate makes that a no-op.
      if (text.startsWith('@@automated::approveInitialPlan@@')) {
        if (setOnboardingState('building')) {
          onProjectStatusChanged?.();
        }
      }

      const { requestId, response } = sendAgentCommand(pm, 'message', {
        text,
        onboardingState: getOnboardingState(),
        ...(attachments?.length ? { attachments } : {}),
        ...(!isAutomated && viewContext ? { viewContext } : {}),
      });
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
    // Clear conversation
    agentClear: async () => {
      const { response } = sendAgentCommand(pm, 'clear', {}, 5_000);
      return await response;
    },
    // Start a fresh session, optionally with per-agent model picks.
    // Distinct from clear: clear preserves the existing model config;
    // newSession replaces it. `models` is a sparse map keyed by agent
    // identifier (parent, visualDesignExpert, ...) — omit (or send
    // empty) to reset every agent to server defaults. Pass-through;
    // remy validates the model IDs and surfaces an `invalid_model_override`
    // error event (broadcast as agentError) when a pick isn't allow-listed.
    agentNewSession: async (p) => {
      const { models } = p as { models?: Record<string, string> };
      const params: Record<string, unknown> = {};
      if (models && typeof models === 'object') {
        params.models = models;
      }
      const { response } = sendAgentCommand(pm, 'newSession', params, 5_000);
      return await response;
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
