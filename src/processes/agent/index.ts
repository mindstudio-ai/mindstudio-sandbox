/**
 * Agent process — manages the remy AI coding agent.
 *
 * Handles startup config, stdout NDJSON event parsing + mapping,
 * chat history retrieval, and WS action handlers.
 */

import type { ProcessManager } from '../process-manager.js';
import type { AgentActivity, AgentFileAction } from '../../types.js';
import type { EditorStateManager } from '../../server/editor-state.js';
import { createLogger } from '../../logger.js';

const log = createLogger('agent');

type ActionHandler = (params: Record<string, unknown>) => Promise<unknown>;

/** Maps remy tool names to file actions. */
const FILE_TOOL_ACTIONS: Record<string, AgentFileAction> = {
  readFile: 'reading',
  writeFile: 'writing',
  editFile: 'editing',
  multiEdit: 'editing',
};

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
  editorState: EditorStateManager;
}

// --- Agent activity tracking ---

let activity: AgentActivity = {
  activeFile: null,
  action: null,
  toolCallId: null,
};
/** Files we auto-opened that weren't already open — close them when done. */
let autoOpenedFile: string | null = null;

export function getAgentActivity(): AgentActivity {
  return { ...activity };
}

function setActivity(
  file: string | null,
  action: AgentFileAction | null,
  toolCallId: string | null,
  cb: AgentCallbacks,
): void {
  activity = { activeFile: file, action, toolCallId };
  cb.broadcast(
    'agentActivityChanged',
    activity as unknown as Record<string, unknown>,
  );
}

function onToolStart(
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

  // Track activity
  setActivity(filePath, fileAction, id, cb);

  // Auto-open for writes/edits so user sees the change happen
  if (fileAction === 'writing' || fileAction === 'editing') {
    const state = cb.editorState.getState();
    const alreadyOpen = state.tabs.some((t) => t.path === filePath);
    if (!alreadyOpen) {
      cb.editorState.openFile(filePath, true);
      autoOpenedFile = filePath;
    } else {
      autoOpenedFile = null;
    }
  } else {
    autoOpenedFile = null;
  }
}

function onToolDone(id: string, cb: AgentCallbacks): void {
  if (activity.toolCallId !== id) {
    return;
  }

  // Auto-close if we opened it and it's still a preview tab
  if (autoOpenedFile) {
    const state = cb.editorState.getState();
    const tab = state.tabs.find((t) => t.path === autoOpenedFile);
    if (tab?.isPreview) {
      cb.editorState.closeFile(autoOpenedFile);
    }
    autoOpenedFile = null;
  }

  setActivity(null, null, null, cb);
}

function onTurnEnd(cb: AgentCallbacks): void {
  if (autoOpenedFile) {
    const state = cb.editorState.getState();
    const tab = state.tabs.find((t) => t.path === autoOpenedFile);
    if (tab?.isPreview) {
      cb.editorState.closeFile(autoOpenedFile);
    }
    autoOpenedFile = null;
  }
  setActivity(null, null, null, cb);
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

      // Track agent file activity
      if (event.event === 'tool_start') {
        onToolStart(event.name, event.id, event.input ?? {}, cb);
      } else if (event.event === 'tool_done') {
        onToolDone(event.id, cb);
      } else if (
        event.event === 'turn_done' ||
        event.event === 'turn_cancelled' ||
        event.event === 'error'
      ) {
        onTurnEnd(cb);
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

/**
 * Transform remy's raw LLM-level history into frontend-friendly format.
 *
 * Raw format:
 *   { role: "user", content: "hi" }
 *   { role: "assistant", content: "text", toolCalls: [{id, name, input}] }
 *   { role: "user", content: "result", toolCallId: "tc_1", isToolError: false }
 *
 * Transformed:
 *   { role: "user", content: "hi" }
 *   { role: "assistant", content: [
 *       { type: "text", text: "text" },
 *       { type: "tool", id: "tc_1", name: "readFile", input: {...}, result: "result", isError: false }
 *   ]}
 */
function transformHistory(raw: unknown[]): unknown[] {
  const result: unknown[] = [];

  for (let i = 0; i < raw.length; i++) {
    const msg = raw[i] as Record<string, unknown>;

    if (msg.role === 'user' && msg.toolCallId) {
      // Tool result — skip, already merged into preceding assistant message
      continue;
    }

    if (msg.role === 'user') {
      result.push({ role: 'user', content: msg.content });
      continue;
    }

    if (msg.role === 'assistant') {
      const blocks: unknown[] = [];

      // Add text block if there's content
      if (
        msg.content &&
        typeof msg.content === 'string' &&
        msg.content.trim()
      ) {
        blocks.push({ type: 'text', text: msg.content });
      }

      // Add tool blocks, merging with subsequent tool result messages
      const toolCalls = msg.toolCalls as
        | Array<{ id: string; name: string; input: unknown }>
        | undefined;
      if (toolCalls) {
        for (const tc of toolCalls) {
          // Find the matching tool result in subsequent messages
          let toolResult: string | undefined;
          let isError = false;
          for (let j = i + 1; j < raw.length; j++) {
            const next = raw[j] as Record<string, unknown>;
            if (next.role === 'user' && next.toolCallId === tc.id) {
              toolResult = next.content as string;
              isError = (next.isToolError as boolean) ?? false;
              break;
            }
            // Stop searching if we hit a non-tool-result message
            if (next.role !== 'user' || !next.toolCallId) {
              break;
            }
          }
          blocks.push({
            type: 'tool',
            id: tc.id,
            name: tc.name,
            input: tc.input,
            result: toolResult,
            isError,
          });
        }
      }

      result.push({ role: 'assistant', content: blocks });
      continue;
    }
  }

  return result;
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
