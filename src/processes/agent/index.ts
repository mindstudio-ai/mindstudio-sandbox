/**
 * Agent process — manages the remy AI coding agent.
 *
 * Handles startup config, stdout NDJSON event parsing + mapping,
 * chat history retrieval, activity tracking, and WS action handlers.
 */

import type { ProcessManager } from '../ProcessManager.js';
import { parseAgentLine } from './events.js';
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
  turn_started: 'agentTurnStarted',
  text: 'agentText',
  thinking: 'agentThinking',
  tool_start: 'agentToolStart',
  tool_input_delta: 'agentToolInputDelta',
  tool_done: 'agentToolDone',
  turn_done: 'agentTurnDone',
  turn_cancelled: 'agentTurnCancelled',
  error: 'agentError',
  stopping: 'agentStopping',
  stopped: 'agentStopped',
  session_restored: 'agentSessionRestored',
  session_cleared: 'agentSessionCleared',
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
]);

/**
 * External tools handled by the sandbox server (not forwarded to frontend).
 * These are suppressed from broadcast and filtered from chat history.
 */
export const SERVER_HANDLED_TOOLS = new Set([
  'editsFinished',
  'setProjectOnboardingState',
  'clearSyncStatus',
]);

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let activity: AgentActivity = { busy: false, fileOps: [] };

/** Tracks external tool calls waiting for a result (e.g., promptUser). */
const pendingExternalTools = new Map<string, PendingExternalTool>();

/** Tool IDs handled server-side — suppress broadcast to frontend for these. */
const serverHandledToolIds = new Set<string>();

export interface PendingExternalTool {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export function getAgentActivity(): AgentActivity {
  return { busy: activity.busy, fileOps: [...activity.fileOps] };
}

export function getPendingExternalTools(): PendingExternalTool[] {
  return Array.from(pendingExternalTools.values());
}

export function hydratePendingExternalTools(
  tools: PendingExternalTool[],
): void {
  pendingExternalTools.clear();
  for (const tool of tools) {
    pendingExternalTools.set(tool.id, tool);
  }
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
    critical: false,
    onStdout: (line) => handleStdout(line, callbacks),
  });
}

/** Send a tool result back to remy for an external tool call. */
export function sendToolResult(
  pm: ProcessManager,
  id: string,
  result: string,
): void {
  if (pm.getState('agent') !== 'running') {
    log.error(`sendToolResult: agent not running (id=${id})`);
    return;
  }
  log.info(`Sending tool_result for ${id}`);
  pendingExternalTools.delete(id);
  pm.writeStdin('agent', JSON.stringify({ action: 'tool_result', id, result }));
}

// ---------------------------------------------------------------------------
// Stdout event handling
// ---------------------------------------------------------------------------

function handleStdout(line: string, cb: AgentCallbacks): void {
  const event = parseAgentLine(line);
  if (!event) {
    return;
  }

  // --- Internal events (not broadcast to frontend) ---

  if (event.event === 'history') {
    resolveHistoryRequest(event.messages);
    return;
  }

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
    case 'turn_started':
      activity = { busy: true, fileOps: [] };
      broadcastActivity(cb);
      break;
    case 'tool_start':
      trackToolStart(event.name, event.id, event.input, cb);
      break;
    case 'tool_done':
      trackToolDone(event.id, cb);
      break;
    case 'turn_done':
    case 'turn_cancelled':
    case 'error':
      activity = { busy: false, fileOps: [] };
      pendingExternalTools.clear();
      cb.onTurnDone?.();
      broadcastActivity(cb);
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
    // Only trigger external tool handling on the final tool_start (no partial flag)
    if (!event.partial) {
      const handled = cb.onExternalTool?.(event.id, event.name, input);
      if (handled) {
        serverHandledToolIds.add(event.id);
      }
    }
  } else if (
    event.event === 'tool_input_delta' &&
    pendingExternalTools.has(event.id)
  ) {
    // Update pending entry with latest streamed content so init frame
    // captures the full content if the client reconnects mid-stream.
    const pending = pendingExternalTools.get(event.id)!;
    pending.input = { ...pending.input, content: event.result };
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
// History request/response
// ---------------------------------------------------------------------------

let historyResolvers: Array<(messages: unknown[]) => void> = [];

function resolveHistoryRequest(messages: unknown[]): void {
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
      resolve(transformHistory(messages));
    });
    pm.writeStdin('agent', JSON.stringify({ action: 'get_history' }));
  });
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
  function send(action: string, extra?: Record<string, unknown>): void {
    if (pm.getState('agent') !== 'running') {
      throw new Error('agent not running');
    }
    pm.writeStdin('agent', JSON.stringify({ action, ...extra }));
  }

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
        send('cancel');
      }

      send('message', {
        text,
        onboardingState: getOnboardingState(),
        ...(attachments?.length ? { attachments } : {}),
        ...(viewContext ? { viewContext } : {}),
      });
      return {};
    },
    agentSync: async () => {
      log.info('Triggering spec/code sync');
      send('message', {
        text: '',
        runCommand: 'sync',
        onboardingState: getOnboardingState(),
        editorContext: {},
      });
      return {};
    },
    agentPublish: async () => {
      log.info('Triggering publish');
      send('message', {
        text: '',
        runCommand: 'publish',
        onboardingState: getOnboardingState(),
        editorContext: {},
      });
      return {};
    },
    agentBuild: async () => {
      log.info('Triggering build');
      // Advance onboarding to initialCodegen when build is triggered
      if (setOnboardingState('initialCodegen')) {
        onProjectStatusChanged?.();
      }
      send('message', {
        text: '',
        runCommand: 'buildFromInitialSpec',
        onboardingState: getOnboardingState(),
        editorContext: {},
      });
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
