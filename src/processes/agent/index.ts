/**
 * Agent process — manages the remy AI coding agent.
 *
 * Handles startup config, stdout NDJSON event parsing + mapping,
 * request correlation, and tool routing. Activity tracking lives in
 * activity.ts; WS action handlers live in actions.ts.
 */

import type { ProcessManager } from '../ProcessManager.js';
import { parseAgentMessage } from './events.js';
import { transformHistory } from './history.js';
import {
  getAgentActivity,
  broadcastActivity,
  startTurn,
  startBackgroundTurn,
  endTurn,
  clearActivityOnError,
  trackToolStart,
  trackToolDone,
  addPendingExternalTool,
  hasPendingExternalTool,
  getPendingExternalTool,
  deletePendingExternalTool,
  updatePendingExternalToolInput,
  addServerHandledToolId,
  isServerHandledToolId,
  deleteServerHandledToolId,
} from './activity.js';
import { createLogger } from '../../logger.js';

const log = createLogger('agent');

// Re-export types and functions used by external consumers
export { getAgentActivity } from './activity.js';
export type {
  AgentActivity,
  AgentFileOp,
  AgentFileAction,
} from './activity.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentCallbacks {
  broadcast: (event: string, data: Record<string, any>) => void;
  onEditsFinished?: () => void;
  /** Return true if the tool was handled server-side (suppresses broadcast to frontend). */
  onExternalTool?: (
    id: string,
    name: string,
    input: Record<string, unknown>,
  ) => boolean;
  onTurnDone?: () => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maps remy's headless event names to our WebSocket event names. */
const EVENT_MAP: Record<string, string> = {
  ready: 'agentReady',
  completed: 'agentCompleted',
  text: 'agentText',
  thinking: 'agentThinking',
  tool_start: 'agentToolStart',
  tool_input_delta: 'agentToolInputDelta',
  tool_done: 'agentToolDone',
  tool_stopped: 'agentToolStopped',
  tool_restarted: 'agentToolRestarted',
  tool_background_complete: 'agentToolBackgroundComplete',
  status: 'agentStatus',
  error: 'agentError',
  stopping: 'agentStopping',
  stopped: 'agentStopped',
  session_restored: 'agentSessionRestored',
  user_message: 'agentUserMessage',
};

/**
 * Tools that remy executes internally (not external).
 * Any tool NOT in this set and NOT 'editsFinished' is treated as an
 * external tool — tracked in pendingExternalTools and forwarded to
 * the sandbox/frontend for handling. This means remy can add new
 * external tools without any sandbox code changes.
 */
const INTERNAL_TOOLS = new Set([
  'readFile',
  'writeFile',
  'editFile',
  'multiEdit',
  'readSpec',
  'writeSpec',
  'editSpec',
  'bash',
  'grep',
  'glob',
  'listDir',
  'lspDiagnostics',
  'restartProcess',
  'screenshot',
]);

/**
 * External tools handled by the sandbox server that are HIDDEN from frontend.
 * Suppressed from broadcast and filtered from chat history.
 */
export const SERVER_HANDLED_TOOLS = new Set([
  'editsFinished',
  'setProjectOnboardingState',
  'setProjectMetadata',
  'clearSyncStatus',
]);

/**
 * External tools handled by the sandbox server that are VISIBLE to frontend.
 * The sandbox sends tool_result, but events are still broadcast and shown in history.
 */
export const SERVER_VISIBLE_TOOLS = new Set([
  'runScenario',
  'runMethod',
  'browserCommand',
  'queryDatabase',
]);

// ---------------------------------------------------------------------------
// requestId-based command correlation
// ---------------------------------------------------------------------------

let requestCounter = 0;
let backgroundTurnCounter = 0;

interface PendingCommand {
  resolve: (response: Record<string, unknown>) => void;
  timer?: ReturnType<typeof setTimeout>;
  /** Accumulated data from pre-completed events (e.g., history messages). */
  data?: Record<string, unknown>;
}

const pending = new Map<string, PendingCommand>();

/**
 * Send a command to the agent and wait for the correlated `completed` event.
 * Returns `{ requestId, response }` so callers can track the requestId
 * (e.g., for activity tracking on message commands).
 *
 * `timeoutMs` is optional — message commands run indefinitely.
 */
export function sendAgentCommand(
  pm: ProcessManager,
  action: string,
  params?: Record<string, unknown>,
  timeoutMs?: number,
): { requestId: string; response: Promise<Record<string, unknown>> } {
  const requestId = `ac-${++requestCounter}`;
  if (pm.getState('agent') !== 'running') {
    return {
      requestId,
      response: Promise.resolve({ success: false, error: 'agent not running' }),
    };
  }
  const response = new Promise<Record<string, unknown>>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (timeoutMs) {
      timer = setTimeout(() => {
        pending.delete(requestId);
        resolve({ success: false, error: `timeout (${timeoutMs / 1000}s)` });
      }, timeoutMs);
    }
    pending.set(requestId, { resolve, timer });
    pm.writeStdin('agent', JSON.stringify({ requestId, action, ...params }));
  });
  return { requestId, response };
}

// ---------------------------------------------------------------------------
// Process lifecycle
// ---------------------------------------------------------------------------

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
    critical: true,
    logStdout: false, // stdout is NDJSON protocol traffic, not useful in log file
    onStdout: (line) => handleStdout(line, callbacks),
  });
}

/** Send a tool result back to remy for an external tool call. Fire-and-forget. */
export function sendToolResult(
  pm: ProcessManager,
  id: string,
  result: string,
): void {
  if (pm.getState('agent') !== 'running') {
    log.error(`sendToolResult: agent not running (id=${id})`, {
      toolCallId: id,
    });
    return;
  }
  log.info(`Sending tool_result for ${id}`, { toolCallId: id });
  deletePendingExternalTool(id);
  pm.writeStdin('agent', JSON.stringify({ action: 'tool_result', id, result }));
}

// ---------------------------------------------------------------------------
// Stdout event handling
// ---------------------------------------------------------------------------

function handleStdout(line: string, cb: AgentCallbacks): void {
  const event = parseAgentMessage(line);
  if (!event) {
    return;
  }

  // --- Turn started — track remy-initiated turns ---

  if (event.event === 'turn_started') {
    if (!event.requestId) {
      // Remy-initiated turn (session restore, background tool results, etc.).
      // Set busy — remy can't accept new messages while processing, so the
      // frontend should disable input regardless of how the turn started.
      const syntheticId = `bg-${++backgroundTurnCounter}`;
      startTurn(syntheticId);
      broadcastActivity(cb.broadcast);
    }
    return;
  }

  // --- User messages (background work results from remy) ---

  if (event.event === 'user_message') {
    if (!event.requestId) {
      // Remy-initiated user message (e.g., background tool results being
      // fed back). Set busy so the frontend knows the agent is processing
      // and disables input — prevents "already processing" errors.
      const syntheticId = `bg-${++backgroundTurnCounter}`;
      startTurn(syntheticId);
      broadcastActivity(cb.broadcast);
    }
    // Broadcast non-hidden messages so frontend can show a marker in chat
    if (!event.hidden) {
      const { event: _evt, ...data } = event;
      cb.broadcast('agentUserMessage', data);
    }
    return;
  }

  // --- Completed events — resolve pending promise & broadcast ---

  if (event.event === 'completed') {
    // Resolve pending request if there is one
    if (event.requestId) {
      const entry = pending.get(event.requestId);
      if (entry) {
        pending.delete(event.requestId);
        if (entry.timer) {
          clearTimeout(entry.timer);
        }
        entry.resolve({ ...entry.data, ...event });
      }
    }

    // End the active turn (whether user-initiated or background)
    if (endTurn(event.requestId)) {
      cb.onTurnDone?.();
      broadcastActivity(cb.broadcast);
    }

    // Always broadcast to frontend as the turn-done signal
    const { event: _evt, ...data } = event;
    cb.broadcast('agentCompleted', data);
    return;
  }

  // --- Data events (history, session_cleared) — accumulate for completed ---

  if (event.event === 'history' && 'requestId' in event && event.requestId) {
    const entry = pending.get(event.requestId);
    if (entry) {
      entry.data = {
        messages: transformHistory(event.messages),
        ...(event.running ? { running: true } : {}),
        ...(event.currentRequestId
          ? { currentRequestId: event.currentRequestId }
          : {}),
      };
    }
    return; // internal, don't broadcast
  }

  if (
    event.event === 'session_cleared' &&
    'requestId' in event &&
    event.requestId
  ) {
    // No data to accumulate — completed will resolve it
    return; // don't broadcast directly, frontend gets agentSessionCleared via EVENT_MAP below
  }

  if (
    event.event === 'compaction_complete' &&
    'requestId' in event &&
    event.requestId
  ) {
    // No data to accumulate — completed will resolve it
    return;
  }

  // --- editsFinished tool — internal, not broadcast ---

  if (
    event.event === 'tool_done' &&
    'name' in event &&
    event.name === 'editsFinished'
  ) {
    cb.onEditsFinished?.();
    return;
  }
  if (
    event.event === 'tool_start' &&
    'name' in event &&
    event.name === 'editsFinished'
  ) {
    return;
  }

  // --- Activity tracking ---

  switch (event.event) {
    case 'tool_start':
      trackToolStart(event.name, event.id, event.input, cb.broadcast);
      break;
    case 'tool_done':
      trackToolDone(event.id, cb.broadcast);
      break;
    case 'error':
      // System-level error (no requestId) — clear activity
      if (!('requestId' in event) || !event.requestId) {
        clearActivityOnError();
        broadcastActivity(cb.broadcast);
      }
      break;
  }

  // --- External tools ---

  if (event.event === 'tool_start' && !INTERNAL_TOOLS.has(event.name)) {
    const input = event.input ?? {};
    addPendingExternalTool(event.id, event.name, input);
    // Suppress broadcast immediately for server-handled tools (before partial
    // streams leak to the frontend).
    if (SERVER_HANDLED_TOOLS.has(event.name)) {
      addServerHandledToolId(event.id);
    }
    // Only trigger external tool handling on the final tool_start (no partial flag)
    if (!event.partial) {
      cb.onExternalTool?.(event.id, event.name, input);
    }
  } else if (
    event.event === 'tool_input_delta' &&
    hasPendingExternalTool(event.id)
  ) {
    // Update pending entry with latest streamed content so init frame
    // captures the full content if the client reconnects mid-stream.
    const pendingTool = getPendingExternalTool(event.id)!;
    updatePendingExternalToolInput(event.id, {
      ...pendingTool.input,
      content: event.result,
    });
  } else if (event.event === 'tool_done' && hasPendingExternalTool(event.id)) {
    deletePendingExternalTool(event.id);
  }

  // --- Broadcast to frontend ---

  // Suppress tool_start/tool_done/tool_input_delta for server-handled tools
  // (e.g., setProjectOnboardingState, clearSyncStatus) — frontend doesn't
  // need to see these.
  if (
    (event.event === 'tool_start' ||
      event.event === 'tool_done' ||
      event.event === 'tool_input_delta') &&
    'id' in event &&
    isServerHandledToolId(event.id)
  ) {
    if (event.event === 'tool_done') {
      deleteServerHandledToolId(event.id);
    }
    return;
  }

  const mappedEvent = EVENT_MAP[event.event] || `agent_${event.event}`;
  const { event: _evt, ...data } = event;
  log.debug('Agent event', {
    event: mappedEvent,
    ...('requestId' in event && event.requestId
      ? { requestId: event.requestId }
      : {}),
    ...('id' in event && event.id ? { toolCallId: event.id } : {}),
    ...('name' in event && event.name ? { name: event.name } : {}),
  });
  cb.broadcast(mappedEvent, data);
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

export interface AgentHistoryResult {
  messages: unknown[];
  running?: boolean;
  currentRequestId?: string;
}

/** Request chat history from the agent. Returns empty if agent isn't running or times out. */
export async function getAgentHistory(
  pm: ProcessManager,
): Promise<AgentHistoryResult> {
  const { response } = sendAgentCommand(pm, 'get_history', {}, 5_000);
  const result = await response;
  return {
    messages: (result.messages as unknown[]) ?? [],
    ...(result.running ? { running: true } : {}),
    ...(result.currentRequestId
      ? { currentRequestId: result.currentRequestId as string }
      : {}),
  };
}
