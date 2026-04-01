/**
 * Agent activity tracking — file ops, pending external tools, turn state.
 *
 * This is a leaf module with no deps on other agent modules, so both
 * index.ts (event handler) and actions.ts (WS actions) can import freely.
 */

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

export interface PendingExternalTool {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maps remy tool names to file actions. */
export const FILE_TOOL_ACTIONS: Record<string, AgentFileAction> = {
  readFile: 'reading',
  writeFile: 'writing',
  editFile: 'editing',
  multiEdit: 'editing',
  readSpec: 'reading',
  writeSpec: 'writing',
  editSpec: 'editing',
};

// ---------------------------------------------------------------------------
// Mutable state
// ---------------------------------------------------------------------------

let activity: AgentActivity = { busy: false, fileOps: [] };
let activeMessageRequestId: string | null = null;
const pendingExternalTools = new Map<string, PendingExternalTool>();
const serverHandledToolIds = new Set<string>();

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

export function getAgentActivity(): AgentActivity {
  return { busy: activity.busy, fileOps: [...activity.fileOps] };
}

export function broadcastActivity(
  broadcast: (event: string, data: Record<string, any>) => void,
): void {
  broadcast('agentActivityChanged', getAgentActivity());
}

// ---------------------------------------------------------------------------
// Turn lifecycle
// ---------------------------------------------------------------------------

export function startTurn(requestId: string): void {
  activeMessageRequestId = requestId;
  activity = { busy: true, fileOps: [] };
}

/** Track a background turn (no busy state, no activity broadcast). */
export function startBackgroundTurn(requestId: string): void {
  activeMessageRequestId = requestId;
}

/**
 * End the active turn. Returns true if a turn was ended.
 * If requestId is provided, only ends the turn if it matches.
 * If requestId is undefined (background turns), ends whatever turn is active.
 */
export function endTurn(requestId: string | undefined): boolean {
  if (!activeMessageRequestId) {
    return false;
  }
  if (requestId && activeMessageRequestId !== requestId) {
    return false;
  }
  activeMessageRequestId = null;
  activity = { busy: false, fileOps: [] };
  pendingExternalTools.clear();
  serverHandledToolIds.clear();
  return true;
}

export function clearActivityOnError(): void {
  activity = { busy: false, fileOps: [] };
  pendingExternalTools.clear();
  serverHandledToolIds.clear();
}

// ---------------------------------------------------------------------------
// Pending external tools
// ---------------------------------------------------------------------------

export function hasPendingExternalTools(): boolean {
  return pendingExternalTools.size > 0;
}

export function clearPendingExternalTools(): void {
  pendingExternalTools.clear();
}

export function addPendingExternalTool(
  id: string,
  name: string,
  input: Record<string, unknown>,
): void {
  pendingExternalTools.set(id, { id, name, input });
}

export function getPendingExternalTool(
  id: string,
): PendingExternalTool | undefined {
  return pendingExternalTools.get(id);
}

export function hasPendingExternalTool(id: string): boolean {
  return pendingExternalTools.has(id);
}

export function deletePendingExternalTool(id: string): void {
  pendingExternalTools.delete(id);
}

export function updatePendingExternalToolInput(
  id: string,
  input: Record<string, unknown>,
): void {
  const tool = pendingExternalTools.get(id);
  if (tool) {
    tool.input = input;
  }
}

// ---------------------------------------------------------------------------
// Server-handled tool IDs
// ---------------------------------------------------------------------------

export function addServerHandledToolId(id: string): void {
  serverHandledToolIds.add(id);
}

export function isServerHandledToolId(id: string): boolean {
  return serverHandledToolIds.has(id);
}

export function deleteServerHandledToolId(id: string): void {
  serverHandledToolIds.delete(id);
}

// ---------------------------------------------------------------------------
// File op tracking
// ---------------------------------------------------------------------------

export function trackToolStart(
  name: string,
  id: string,
  input: Record<string, unknown>,
  broadcast: (event: string, data: Record<string, any>) => void,
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
  broadcastActivity(broadcast);
}

export function trackToolDone(
  id: string,
  broadcast: (event: string, data: Record<string, any>) => void,
): void {
  const idx = activity.fileOps.findIndex((op) => op.toolCallId === id);
  if (idx !== -1) {
    activity.fileOps.splice(idx, 1);
    broadcastActivity(broadcast);
  }
}
