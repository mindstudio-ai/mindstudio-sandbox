/**
 * Agent activity tracking — file ops, pending external tools, turn state,
 * and the live queue snapshot.
 *
 * This is a leaf module with no runtime deps on other agent modules (only a
 * type-only import for QueuedMessage), so both index.ts (event handler) and
 * actions.ts (WS actions) can import freely.
 */

import type { QueuedMessage } from './events.js';

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
// The current pending-queue snapshot, reconciled from remy's queue_changed
// events. Drives the queue dimension of derived busy (see getAgentActivity).
let currentQueue: QueuedMessage[] = [];

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

export function getAgentActivity(): AgentActivity {
  // Busy is derived: a foreground turn is running OR work is queued. Keeping it
  // true while the queue is non-empty stops the FE (and the HMR flush wired to
  // this signal) from going idle between chained/queued turns.
  return {
    busy: activity.busy || currentQueue.length > 0,
    fileOps: [...activity.fileOps],
  };
}

export function broadcastActivity(
  broadcast: (event: string, data: Record<string, any>) => void,
): void {
  broadcast('agentActivityChanged', getAgentActivity());
}

// ---------------------------------------------------------------------------
// Queue snapshot (reconciled from remy's queue_changed events)
// ---------------------------------------------------------------------------

export function getQueuedMessages(): QueuedMessage[] {
  return [...currentQueue];
}

/**
 * Replace the tracked queue snapshot. Broadcasts agentActivityChanged only when
 * the derived busy state actually flips (e.g. the queue goes empty↔non-empty
 * while no foreground turn is running) to avoid redundant activity churn.
 */
export function setQueuedMessages(
  snapshot: QueuedMessage[],
  broadcast: (event: string, data: Record<string, any>) => void,
): void {
  const wasBusy = getAgentActivity().busy;
  currentQueue = snapshot;
  if (getAgentActivity().busy !== wasBusy) {
    broadcastActivity(broadcast);
  }
}

// ---------------------------------------------------------------------------
// Turn lifecycle
// ---------------------------------------------------------------------------

export function startTurn(requestId: string): void {
  activeMessageRequestId = requestId;
  activity = { busy: true, fileOps: [] };
}

/** The requestId of the active foreground turn, or null if none. */
export function getActiveTurnId(): string | null {
  return activeMessageRequestId;
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

// Subset of external tools that block on a user action (answering a form,
// approving a plan, confirming a destructive op). Mirrors remy's
// USER_BLOCKING_EXTERNAL_TOOLS in remy/src/agent.ts — keep the two in sync.
// Only these should force a turn-cancel when a message arrives mid-turn: remy
// is stuck until the user acts, so the message would otherwise never process.
// Every other in-flight tool (QA/browser sub-agents, design expert, runMethod,
// …) resolves on its own, so a mid-turn message must queue and run after.
const USER_BLOCKING_TOOLS = new Set([
  'promptUser',
  'presentPublishPlan',
  'confirmDestructiveAction',
]);

/**
 * True only when remy is awaiting a user-blocking external tool (a form, a plan
 * approval, a destructive-action confirm) — the sole case where a mid-turn
 * message must cancel the turn to unblock remy. A pending autonomous tool (QA
 * agent, design expert, runMethod, …) does not count: it resolves on its own,
 * so the message should queue and run when the turn completes.
 */
export function hasPendingUserBlockingTool(): boolean {
  for (const tool of pendingExternalTools.values()) {
    if (USER_BLOCKING_TOOLS.has(tool.name)) {
      return true;
    }
  }
  return false;
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
