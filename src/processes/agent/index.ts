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
  session_cleared: 'agentSessionCleared',
  models_changed: 'agentModelsChanged',
  user_message: 'agentUserMessage',
  compaction_started: 'agentCompactionStarted',
  compaction_complete: 'agentCompactionComplete',
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

// ---------------------------------------------------------------------------
// Aborted-trigger tracking (Continue button after cancel mid-chain)
// ---------------------------------------------------------------------------

/** Text of the currently-running automated turn, captured from user_message. */
let currentAutomatedTurnText: string | null = null;
/** Last automated trigger that was cancelled — drives the Continue button. */
let lastAbortedTrigger: string | null = null;

export function getLastAbortedTrigger(): string | null {
  return lastAbortedTrigger;
}

/**
 * Set the last aborted trigger. Broadcasts `lastAbortedTriggerChanged` only
 * when the value actually changes so repeated clears don't spam clients.
 */
export function setLastAbortedTrigger(
  value: string | null,
  broadcast: AgentCallbacks['broadcast'],
): void {
  if (lastAbortedTrigger === value) {
    return;
  }
  lastAbortedTrigger = value;
  broadcast('lastAbortedTriggerChanged', { lastAbortedTrigger: value });
}

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
        log.warn(
          `Command "${action}" timed out after ${timeoutMs}ms (requestId=${requestId})`,
        );
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
    onStdout: (line) => handleStdout(line, pm, callbacks),
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

function handleStdout(
  line: string,
  pm: ProcessManager,
  cb: AgentCallbacks,
): void {
  const event = parseAgentMessage(line);
  if (!event) {
    log.warn(
      `Dropped unparseable agent stdout line (${line.length} bytes): ${line.slice(0, 200)}${line.length > 200 ? '…' : ''}`,
    );
    return;
  }

  // --- Ready / session_restored — auto-resume the queue if non-empty.
  // Remy persists the queue to .remy-stats.json across restarts but does
  // NOT auto-drain. Send the dedicated `resume` action to kick it off.
  if (event.event === 'ready' || event.event === 'session_restored') {
    // Forward session_restored to the frontend — it carries the active
    // per-agent model picks (models) and conversation size needed for
    // "running on X" banners and model-picker hydration. ready stays
    // sandbox-internal (no FE-visible info beyond what the init frame
    // already broadcasts).
    if (event.event === 'session_restored') {
      const { event: _evt, ...data } = event;
      cb.broadcast('agentSessionRestored', data);
    }
    if ((event.queuedMessages?.length ?? 0) > 0) {
      log.info(
        `Queue non-empty on ${event.event} (${event.queuedMessages?.length} items) — sending resume`,
      );
      // Fire-and-forget. Remy's contract: resume completes immediately,
      // per-turn events follow as the queue drains.
      sendAgentCommand(pm, 'resume', {}, 30_000);
    }
    return;
  }

  // --- Queued event — a message was enqueued instead of rejected. Under
  // our policy only automated messages reach remy while busy, so this
  // should be rare. Pass through so frontend can surface if desired.
  if (event.event === 'queued') {
    const { event: _evt, ...data } = event;
    cb.broadcast('agentQueued', data);
    return;
  }

  // --- Turn started — track remy-initiated turns ---

  if (event.event === 'turn_started') {
    const turnId = event.requestId;
    if (!turnId) {
      // Legacy path (pre-uniform-user_message contract): remy didn't emit a
      // requestId for internally-triggered turns. Synthesize one so busy
      // state still flips.
      const syntheticId = `bg-${++backgroundTurnCounter}`;
      startTurn(syntheticId);
      broadcastActivity(cb.broadcast);
    } else if (!turnId.startsWith('ac-')) {
      // Remy-initiated turn (chain-*, bg-*). ac-* turns are already tracked
      // via startTurn() at the sendAgentCommand site in actions.ts, so we
      // only handle the non-ac prefixes here.
      startTurn(turnId);
      broadcastActivity(cb.broadcast);
    }
    return;
  }

  // --- User messages — turn-starting message echoed by remy for every
  // turn (ac-*, chain-*, bg-*). Activity tracking lives in turn_started.
  // Rendering is driven by the @@automated::X@@ prefix in `text`. ---

  if (event.event === 'user_message') {
    // Snapshot the trigger text for potential cancel → Continue-button
    // re-trigger. Only automated turns (sandbox- or chain-initiated) get
    // tracked; user-typed messages don't surface a resume affordance.
    currentAutomatedTurnText = event.text.startsWith('@@automated::')
      ? event.text
      : null;
    const { event: _evt, ...data } = event;
    cb.broadcast('agentUserMessage', data);
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

    // More queued work means remy is firing turn_started for the next
    // item immediately. Don't flip busy to idle in the gap — the frontend
    // shouldn't flicker between pipeline steps. Still fire onTurnDone so
    // a snapshot checkpoint runs between items.
    const hasMoreQueuedWork = (event.queuedMessages?.length ?? 0) > 0;

    if (hasMoreQueuedWork) {
      cb.onTurnDone?.();
    } else if (endTurn(event.requestId)) {
      cb.onTurnDone?.();
      broadcastActivity(cb.broadcast);
    }

    // Always broadcast to frontend as the turn-done signal. Spread carries
    // queuedMessages / cancelledMessages through to the frontend opaquely.
    const { event: _evt, ...data } = event;
    cb.broadcast('agentCompleted', data);

    // If an automated turn was cancelled (success: false), snapshot its
    // trigger text so the frontend can offer a Continue button. Clear the
    // per-turn captured text regardless so the next turn starts fresh.
    if (!event.success && currentAutomatedTurnText) {
      setLastAbortedTrigger(currentAutomatedTurnText, cb.broadcast);
    }
    currentAutomatedTurnText = null;
    return;
  }

  // --- Data events (history, session_cleared) — accumulate for completed ---

  if (event.event === 'history' && 'requestId' in event && event.requestId) {
    const entry = pending.get(event.requestId);
    const transformed = transformHistory(event.messages);
    log.info('Received history event', {
      requestId: event.requestId,
      hasPendingEntry: !!entry,
      rawMessagesLength: Array.isArray(event.messages)
        ? event.messages.length
        : -1,
      transformedLength: transformed.length,
      startIndex: event.startIndex,
      endIndex: event.endIndex,
      totalMessageCount: event.totalMessageCount,
    });
    if (entry) {
      entry.data = {
        messages: transformed,
        ...(event.running ? { running: true } : {}),
        ...(event.currentRequestId
          ? { currentRequestId: event.currentRequestId }
          : {}),
        ...(typeof event.startIndex === 'number'
          ? { startIndex: event.startIndex }
          : {}),
        ...(typeof event.endIndex === 'number'
          ? { endIndex: event.endIndex }
          : {}),
        ...(typeof event.totalMessageCount === 'number'
          ? { totalMessageCount: event.totalMessageCount }
          : {}),
        ...(event.models ? { models: event.models } : {}),
        ...(event.modelSurfaces ? { modelSurfaces: event.modelSurfaces } : {}),
        ...(event.allowedModelsByType
          ? { allowedModelsByType: event.allowedModelsByType }
          : {}),
      };
    }
    return; // internal, don't broadcast
  }

  // changeModels streams models_changed (instead of history — no reset) ahead
  // of its completed. Accumulate the same model fields the history event
  // carries so the agentChangeModels response resolves with the updated picks.
  // A non-correlated emission (no requestId) falls through to the generic
  // broadcast as agentModelsChanged.
  if (
    event.event === 'models_changed' &&
    'requestId' in event &&
    event.requestId
  ) {
    const entry = pending.get(event.requestId);
    if (entry) {
      entry.data = {
        ...(event.models ? { models: event.models } : {}),
        ...(event.modelSurfaces ? { modelSurfaces: event.modelSurfaces } : {}),
        ...(event.allowedModelsByType
          ? { allowedModelsByType: event.allowedModelsByType }
          : {}),
      };
    }
    return; // internal, don't broadcast
  }

  // compaction_started / compaction_complete fall through to the generic
  // EVENT_MAP broadcast at the bottom of this function. The gate path
  // emits these standalone (no wrapping `completed` event), so we forward
  // each one verbatim to the frontend.

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
  // (e.g., setProjectOnboardingState) — frontend doesn't need to see these.
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
  /**
   * Pagination metadata from remy's paginated `get_history`. Indices
   * refer to remy's full state.messages array — opaque cursors. Note:
   * `transformHistory` filters drop some messages, so
   * `messages.length <= endIndex - startIndex`. `startIndex === 0`
   * indicates no older messages remain to load.
   */
  startIndex?: number;
  endIndex?: number;
  totalMessageCount?: number;
  /**
   * Per-agent model picks active on the session (sparse map; absent
   * means "all server defaults"). Passed through verbatim from remy's
   * history event — the frontend reads this to hydrate the "running on
   * X" banner and the model picker.
   */
  models?: Record<string, string>;
  /**
   * Picker registry shipped over the wire by remy. The frontend reads
   * these instead of carrying its own hardcoded constants. Always
   * present from current remy versions; older versions omit.
   */
  modelSurfaces?: Record<
    string,
    {
      default: string;
      label: string;
      description?: string;
      modelType: string;
      userPickable: boolean;
    }
  >;
  allowedModelsByType?: Record<string, string[]>;
}

export interface GetAgentHistoryOpts {
  /** Exclusive upper bound on message index. Omit for "from the end". */
  before?: number;
  /** Page size. Defaults to remy's default (500). Hard cap is 2000. */
  limit?: number;
}

/** Request chat history from the agent. Returns empty if agent isn't running or times out. */
export async function getAgentHistory(
  pm: ProcessManager,
  opts?: GetAgentHistoryOpts,
): Promise<AgentHistoryResult> {
  const params: Record<string, unknown> = {};
  if (opts?.before !== undefined) {
    params.before = opts.before;
  }
  if (opts?.limit !== undefined) {
    params.limit = opts.limit;
  }
  // 30s, not 5s — pages can be ~2 MB and the JSON parse + transformHistory
  // pipeline can compete with broadcast/handler work on the event loop.
  const { response } = sendAgentCommand(pm, 'get_history', params, 30_000);
  const result = await response;
  return {
    messages: (result.messages as unknown[]) ?? [],
    ...(result.running ? { running: true } : {}),
    ...(result.currentRequestId
      ? { currentRequestId: result.currentRequestId as string }
      : {}),
    ...(typeof result.startIndex === 'number'
      ? { startIndex: result.startIndex }
      : {}),
    ...(typeof result.endIndex === 'number'
      ? { endIndex: result.endIndex }
      : {}),
    ...(typeof result.totalMessageCount === 'number'
      ? { totalMessageCount: result.totalMessageCount }
      : {}),
    ...(result.models && typeof result.models === 'object'
      ? { models: result.models as Record<string, string> }
      : {}),
    ...(result.modelSurfaces && typeof result.modelSurfaces === 'object'
      ? {
          modelSurfaces:
            result.modelSurfaces as AgentHistoryResult['modelSurfaces'],
        }
      : {}),
    ...(result.allowedModelsByType &&
    typeof result.allowedModelsByType === 'object'
      ? {
          allowedModelsByType: result.allowedModelsByType as Record<
            string,
            string[]
          >,
        }
      : {}),
  };
}
