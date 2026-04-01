/**
 * Agent WS action handlers — frontend-facing commands for the agent.
 */

import type { ProcessManager } from '../ProcessManager.js';
import { sendAgentCommand } from './index.js';
import {
  hasPendingExternalTools,
  clearPendingExternalTools,
  startTurn,
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
  callbacks?: { onProjectStatusChanged?: () => void },
): Record<string, ActionHandler> {
  const onProjectStatusChanged = callbacks?.onProjectStatusChanged;

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

      // Advance onboarding to initialCodegen when build is triggered
      if (text.startsWith('@@automated::buildFromInitialSpec@@')) {
        if (setOnboardingState('initialCodegen')) {
          onProjectStatusChanged?.();
        }
      }

      const isAutomated = text.startsWith('@@automated::');

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
      return await response;
    },
    // Clear conversation
    agentClear: async () => {
      const { response } = sendAgentCommand(pm, 'clear', {}, 5_000);
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
