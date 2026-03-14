/**
 * Agent process — manages the remy AI coding agent.
 *
 * Handles startup config, stdout NDJSON event parsing + mapping,
 * chat history retrieval, and WS action handlers.
 */

import type { ProcessManager } from '../process-manager.js';
import { createLogger } from '../../logger.js';

const log = createLogger('agent');

type ActionHandler = (params: Record<string, unknown>) => Promise<unknown>;

/** Maps remy's headless event names to our WebSocket event names. */
const EVENT_MAP: Record<string, string> = {
  ready: 'agentReady',
  text: 'agentText',
  thinking: 'agentThinking',
  tool_start: 'agentToolStart',
  tool_done: 'agentToolDone',
  turn_done: 'agentTurnDone',
  turn_cancelled: 'agentTurnCancelled',
  error: 'agentError',
  stopping: 'agentStopping',
  stopped: 'agentStopped',
  session_restored: 'agentSessionRestored',
  session_cleared: 'agentSessionCleared',
};

export interface AgentCallbacks {
  broadcast: (event: string, data: Record<string, unknown>) => void;
}

export function startAgent(
  pm: ProcessManager,
  config: { workspaceDir: string; apiKey: string; apiBaseUrl: string },
  callbacks: AgentCallbacks,
): void {
  pm.start({
    name: 'agent',
    command: 'remy',
    args: [
      '--headless',
      '--api-key',
      config.apiKey,
      '--base-url',
      config.apiBaseUrl,
      '--lsp-url',
      'http://localhost:4388',
      '--log-level',
      'debug',
    ],
    cwd: config.workspaceDir,
    stdin: true,
    restartOnCrash: false,
    maxRestarts: 0,
    critical: false,
    onStdout: (line) => handleStdout(line, callbacks),
  });
}

function handleStdout(line: string, cb: AgentCallbacks): void {
  try {
    const event = JSON.parse(line);
    if (event && typeof event.event === 'string') {
      if (event.event === 'history') {
        resolveHistoryRequest(event.messages ?? []);
        return;
      }

      const mappedEvent = EVENT_MAP[event.event] || `agent_${event.event}`;
      const { event: _evt, ...data } = event;
      log.debug(
        `Event: ${mappedEvent}${data.text ? ` "${data.text.slice(0, 80)}..."` : ''}`,
      );
      cb.broadcast(mappedEvent, data);
    }
  } catch {
    // Non-JSON stdout — already captured by registry via ProcessManager
  }
}

// --- History request/response ---

let historyResolvers: Array<(messages: unknown[]) => void> = [];

/** Called when a `history` event arrives from the agent. */
export function resolveHistoryRequest(messages: unknown[]): void {
  const resolvers = historyResolvers;
  historyResolvers = [];
  for (const resolve of resolvers) {
    resolve(messages);
  }
}

/** Request chat history from the agent. Returns [] if agent isn't running or times out. */
export function getAgentHistory(pm: ProcessManager): Promise<unknown[]> {
  if (pm.getState('agent') !== 'running') {
    return Promise.resolve([]);
  }
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      historyResolvers = historyResolvers.filter((r) => r !== resolve);
      resolve([]);
    }, 2000);
    historyResolvers.push((messages) => {
      clearTimeout(timeout);
      resolve(messages);
    });
    pm.writeStdin('agent', JSON.stringify({ action: 'get_history' }));
  });
}

/** Create WS action handlers for agent commands. */
export function createAgentActions(
  pm: ProcessManager,
): Record<string, ActionHandler> {
  function send(action: string, extra?: Record<string, unknown>): void {
    if (pm.getState('agent') !== 'running') {
      throw new Error('agent not running');
    }
    pm.writeStdin('agent', JSON.stringify({ action, ...extra }));
  }

  return {
    agentMessage: async (p) => {
      const { text } = p as { text: string };
      log.info(`Sending message: ${text.slice(0, 100)}...`);
      send('message', { text });
      return {};
    },
    agentCancel: async () => {
      send('cancel');
      return {};
    },
    agentClear: async () => {
      send('clear');
      return {};
    },
  };
}
