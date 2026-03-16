/**
 * Agent process — manages the remy AI coding agent.
 *
 * Handles startup config, stdout NDJSON event parsing + mapping,
 * chat history retrieval, activity tracking, and WS action handlers.
 */

import type { ProcessManager } from '../ProcessManager.js';
import { projectHasCode } from '../../server/states/_helpers/getProjectHasCode.js';
import { ctx } from '../../server/context.js';

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
import { createLogger } from '../../logger.js';

const log = createLogger('agent');

type ActionHandler = (params: Record<string, unknown>) => Promise<unknown>;

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

/** Tools where the sandbox handles execution and sends results back to remy. */
const EXTERNAL_TOOLS = new Set(['setViewMode', 'promptUser']);

export interface AgentCallbacks {
  broadcast: (event: string, data: Record<string, any>) => void;
  onEditsFinished?: () => void;
  onExternalTool?: (
    id: string,
    name: string,
    input: Record<string, unknown>,
  ) => void;
  onTurnDone?: () => void;
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
  pm.writeStdin('agent', JSON.stringify({ action: 'tool_result', id, result }));
}

// --- Agent activity tracking ---
// Tracks all in-flight file operations. The server broadcasts facts;
// the frontend decides how to render them (tree icons, overlays, etc.)

let activity: AgentActivity = { busy: false, fileOps: [] };

export function getAgentActivity(): AgentActivity {
  return { busy: activity.busy, fileOps: [...activity.fileOps] };
}

function broadcastActivity(cb: AgentCallbacks): void {
  cb.broadcast('agentActivityChanged', getAgentActivity());
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

  activity.fileOps.push({ toolCallId: id, path: filePath, action: fileAction });
  broadcastActivity(cb);
}

function onToolDone(id: string, cb: AgentCallbacks): void {
  const idx = activity.fileOps.findIndex((op) => op.toolCallId === id);
  if (idx !== -1) {
    activity.fileOps.splice(idx, 1);
    broadcastActivity(cb);
  }
}

function onTurnStart(cb: AgentCallbacks): void {
  activity = { busy: true, fileOps: [] };
  broadcastActivity(cb);
}

function onTurnEnd(cb: AgentCallbacks): void {
  activity = { busy: false, fileOps: [] };
  cb.onTurnDone?.();
  broadcastActivity(cb);
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

      // Track agent activity
      if (event.event === 'tool_start') {
        // First tool_start of a turn marks the agent as busy
        if (!activity.busy) {
          onTurnStart(cb);
        }
        onToolStart(event.name, event.id, event.input ?? {}, cb);
      } else if (event.event === 'tool_done') {
        onToolDone(event.id, cb);
      } else if (event.event === 'text' && !activity.busy) {
        // Agent started responding with text (no tools yet)
        onTurnStart(cb);
      } else if (
        event.event === 'turn_done' ||
        event.event === 'turn_cancelled' ||
        event.event === 'error'
      ) {
        onTurnEnd(cb);
      }

      // editsFinished is an internal signal — don't show in chat
      if (event.name === 'editsFinished') {
        if (event.event === 'tool_done') {
          cb.onEditsFinished?.();
        }
        return;
      }

      // External tools: sandbox handles them and sends results back to remy.
      // Still broadcast to frontend (needed for promptUser UI, tool_done transitions).
      if (EXTERNAL_TOOLS.has(event.name) && event.event === 'tool_start') {
        cb.onExternalTool?.(
          event.id,
          event.name,
          (event.input as Record<string, unknown>) ?? {},
        );
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
      const userMsg: Record<string, unknown> = {
        role: 'user',
        content: msg.content,
      };
      if (msg.attachments) {
        userMsg.attachments = msg.attachments;
      }
      result.push(userMsg);
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
          // Filter out internal-only tools
          if (tc.name === 'editsFinished') {
            continue;
          }
          let toolResult: string | undefined;
          let isError = false;
          for (let j = i + 1; j < raw.length; j++) {
            const next = raw[j] as Record<string, unknown>;
            if (next.role === 'user' && next.toolCallId === tc.id) {
              toolResult = next.content as string;
              isError = (next.isToolError as boolean) ?? false;
              break;
            }
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
      const { text, attachments } = p as {
        text: string;
        attachments?: Array<{ url: string; extractedTextUrl?: string }>;
      };
      log.info(`Sending message: ${text.slice(0, 100)}...`);

      // Gather view context so remy knows what the user is looking at
      const viewMode = ctx.viewMode;
      const activeEditor =
        viewMode === 'spec'
          ? ctx.specEditorState
          : viewMode === 'code'
            ? ctx.editorState
            : null;
      const editorState = activeEditor?.getState();

      send('message', {
        text,
        projectHasCode: projectHasCode(),
        ...(attachments?.length ? { attachments } : {}),
        viewContext: {
          mode: viewMode,
          openFiles: editorState?.tabs.map((t) => t.path) ?? [],
          activeFile: editorState?.activeTab ?? null,
        },
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
