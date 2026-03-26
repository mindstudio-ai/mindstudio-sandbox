/**
 * Agent process — manages the remy AI coding agent.
 *
 * Handles startup config, stdout NDJSON event parsing + mapping,
 * chat history retrieval, activity tracking, and WS action handlers.
 * Uses requestId-based correlation for all stdin commands.
 */

import type { ProcessManager } from '../ProcessManager.js';
import { parseAgentMessage } from './events.js';
import { transformHistory } from './history.js';
import { getOnboardingState, setOnboardingState } from '../../projectStatus.js';
import { createLogger } from '../../logger.js';

const log = createLogger('agent');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AgentFileAction = 'reading' | 'writing' | 'editing';

export interface AgentFileOp {
  toolCallId: string;
  path: string;
  action: AgentFileAction;
}

export interface AgentActivity {
  busy: boolean;
  fileOps: AgentFileOp[];
}

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

type ActionHandler = (params: Record<string, unknown>) => Promise<unknown>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maps remy tool names to file actions. */
const FILE_TOOL_ACTIONS: Record<string, AgentFileAction> = {
  readFile: 'reading',
  writeFile: 'writing',
  editFile: 'editing',
  multiEdit: 'editing',
  readSpec: 'reading',
  writeSpec: 'writing',
  editSpec: 'editing',
};

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
};

/**
 * Tools that remy executes internally (not external).
 * Any tool NOT in this set and NOT 'editsFinished' is treated as an
 * external tool — tracked in pendingExternalTools and forwarded to
 * the sandbox/frontend for handling. This means remy can add new
 * external tools without any sandbox code changes.
 */
const INTERNAL_TOOLS = new Set([
  ...Object.keys(FILE_TOOL_ACTIONS),
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
]);

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let activity: AgentActivity = { busy: false, fileOps: [] };

/** The requestId of the currently in-flight message command (for activity tracking). */
let activeMessageRequestId: string | null = null;

/** Tracks external tool calls waiting for a result (e.g., promptUser). */
const pendingExternalTools = new Map<string, PendingExternalTool>();

/** Tool IDs handled server-side — suppress broadcast to frontend for these. */
const serverHandledToolIds = new Set<string>();

interface PendingExternalTool {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export function getAgentActivity(): AgentActivity {
  return { busy: activity.busy, fileOps: [...activity.fileOps] };
}

// ---------------------------------------------------------------------------
// requestId-based command correlation
// ---------------------------------------------------------------------------

let requestCounter = 0;

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
  pendingExternalTools.delete(id);
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

  // --- Completed events — resolve pending promise ---

  if (event.event === 'completed' && 'requestId' in event && event.requestId) {
    const entry = pending.get(event.requestId);
    if (entry) {
      pending.delete(event.requestId);
      if (entry.timer) {
        clearTimeout(entry.timer);
      }
      entry.resolve({ ...entry.data, ...event });
    }

    // If this was the active message, mark not busy
    if (activeMessageRequestId === event.requestId) {
      activeMessageRequestId = null;
      activity = { busy: false, fileOps: [] };
      pendingExternalTools.clear();
      serverHandledToolIds.clear();
      cb.onTurnDone?.();
      broadcastActivity(cb);
    }

    // Broadcast to frontend as the turn-done signal
    const { event: _evt, ...data } = event;
    cb.broadcast('agentCompleted', data);
    return;
  }

  // --- Data events (history, session_cleared) — accumulate for completed ---

  if (event.event === 'history' && 'requestId' in event && event.requestId) {
    const entry = pending.get(event.requestId);
    if (entry) {
      entry.data = { messages: transformHistory(event.messages) };
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
      trackToolStart(event.name, event.id, event.input, cb);
      break;
    case 'tool_done':
      trackToolDone(event.id, cb);
      break;
    case 'error':
      // System-level error (no requestId) — clear activity
      if (!('requestId' in event) || !event.requestId) {
        activity = { busy: false, fileOps: [] };
        pendingExternalTools.clear();
        serverHandledToolIds.clear();
        broadcastActivity(cb);
      }
      break;
  }

  // --- External tools ---

  if (event.event === 'tool_start' && !INTERNAL_TOOLS.has(event.name)) {
    const input = event.input ?? {};
    pendingExternalTools.set(event.id, {
      id: event.id,
      name: event.name,
      input,
    });
    // Suppress broadcast immediately for server-handled tools (before partial
    // streams leak to the frontend).
    if (SERVER_HANDLED_TOOLS.has(event.name)) {
      serverHandledToolIds.add(event.id);
    }
    // Only trigger external tool handling on the final tool_start (no partial flag)
    if (!event.partial) {
      cb.onExternalTool?.(event.id, event.name, input);
    }
  } else if (
    event.event === 'tool_input_delta' &&
    pendingExternalTools.has(event.id)
  ) {
    // Update pending entry with latest streamed content so init frame
    // captures the full content if the client reconnects mid-stream.
    const pendingTool = pendingExternalTools.get(event.id)!;
    pendingTool.input = { ...pendingTool.input, content: event.result };
  } else if (
    event.event === 'tool_done' &&
    pendingExternalTools.has(event.id)
  ) {
    pendingExternalTools.delete(event.id);
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
    serverHandledToolIds.has(event.id)
  ) {
    if (event.event === 'tool_done') {
      serverHandledToolIds.delete(event.id);
    }
    return;
  }

  const mappedEvent = EVENT_MAP[event.event] || `agent_${event.event}`;
  const { event: _evt, ...data } = event;
  log.debug(
    `Event: ${mappedEvent}${'text' in data && data.text ? ` "${String(data.text).slice(0, 80)}..."` : ''}`,
    {
      ...('requestId' in event && event.requestId
        ? { requestId: event.requestId }
        : {}),
      ...('id' in event && event.id ? { toolCallId: event.id } : {}),
    },
  );
  cb.broadcast(mappedEvent, data);
}

function broadcastActivity(cb: AgentCallbacks): void {
  cb.broadcast('agentActivityChanged', getAgentActivity());
}

function trackToolStart(
  name: string,
  id: string,
  input: Record<string, unknown>,
  cb: AgentCallbacks,
): void {
  const fileAction = FILE_TOOL_ACTIONS[name];
  if (!fileAction) {
    return;
  }
  const filePath = (input.path ?? input.file) as string | undefined;
  if (!filePath) {
    return;
  }
  activity.fileOps.push({ toolCallId: id, path: filePath, action: fileAction });
  broadcastActivity(cb);
}

function trackToolDone(id: string, cb: AgentCallbacks): void {
  const idx = activity.fileOps.findIndex((op) => op.toolCallId === id);
  if (idx !== -1) {
    activity.fileOps.splice(idx, 1);
    broadcastActivity(cb);
  }
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

/** Request chat history from the agent. Returns [] if agent isn't running or times out. */
export async function getAgentHistory(pm: ProcessManager): Promise<unknown[]> {
  const { response } = sendAgentCommand(pm, 'get_history', {}, 5_000);
  const result = await response;
  return (result.messages as unknown[]) ?? [];
}

// ---------------------------------------------------------------------------
// WS action handlers
// ---------------------------------------------------------------------------

/** Create WS action handlers for agent commands. */
export function createAgentActions(
  pm: ProcessManager,
  callbacks?: { onProjectStatusChanged?: () => void },
): Record<string, ActionHandler> {
  const onProjectStatusChanged = callbacks?.onProjectStatusChanged;

  return {
    agentMessage: async (p) => {
      const { text, attachments, viewContext } = p as {
        text: string;
        attachments?: Array<{ url: string; extractedTextUrl?: string }>;
        viewContext?: Record<string, unknown>;
      };
      log.info(`Sending message: ${text.slice(0, 100)}...`);

      // If remy is blocked waiting for an external tool result (e.g., a
      // promptUser that was never answered), cancel the current turn first
      // so remy can accept the new message.
      if (pendingExternalTools.size > 0) {
        log.info('Cancelling pending external tools before sending message');
        pendingExternalTools.clear();
        const { response: cancelResponse } = sendAgentCommand(
          pm,
          'cancel',
          {},
          5_000,
        );
        await cancelResponse;
      }

      const { requestId, response } = sendAgentCommand(pm, 'message', {
        text,
        onboardingState: getOnboardingState(),
        ...(attachments?.length ? { attachments } : {}),
        ...(viewContext ? { viewContext } : {}),
      });
      activeMessageRequestId = requestId;
      activity = { busy: true, fileOps: [] };
      return await response;
    },
    agentSync: async () => {
      log.info('Triggering spec/code sync');
      const { requestId, response } = sendAgentCommand(pm, 'message', {
        text: '',
        runCommand: 'sync',
        onboardingState: getOnboardingState(),
        editorContext: {},
      });
      activeMessageRequestId = requestId;
      activity = { busy: true, fileOps: [] };
      return await response;
    },
    agentPublish: async () => {
      log.info('Triggering publish');
      const { requestId, response } = sendAgentCommand(pm, 'message', {
        text: '',
        runCommand: 'publish',
        onboardingState: getOnboardingState(),
        editorContext: {},
      });
      activeMessageRequestId = requestId;
      activity = { busy: true, fileOps: [] };
      return await response;
    },
    agentBuild: async () => {
      log.info('Triggering build');
      // Advance onboarding to initialCodegen when build is triggered
      if (setOnboardingState('initialCodegen')) {
        onProjectStatusChanged?.();
      }
      const { requestId, response } = sendAgentCommand(pm, 'message', {
        text: '',
        runCommand: 'buildFromInitialSpec',
        onboardingState: getOnboardingState(),
        editorContext: {},
      });
      activeMessageRequestId = requestId;
      activity = { busy: true, fileOps: [] };
      return await response;
    },
    agentCancel: async () => {
      const { response } = sendAgentCommand(pm, 'cancel', {}, 5_000);
      return await response;
    },
    agentClear: async () => {
      const { response } = sendAgentCommand(pm, 'clear', {}, 5_000);
      return await response;
    },
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
