/**
 * Agent activity tracking — file ops, pending external tools, turn state,
 * and the live queue snapshot.
 *
 * This is a leaf module with no runtime deps on other agent modules (only a
 * type-only import for QueuedMessage), so both index.ts (event handler) and
 * actions.ts (WS actions) can import freely.
 */

import type { ModelOverride, QueuedMessage } from './events.ts';

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

/** Model attribution remy reported for the turn currently in flight. */
export interface ActiveTurnModel {
  model?: string;
  modelOverride?: ModelOverride;
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
// Attribution for the in-flight turn, cached so a client connecting mid-turn
// can be told which model is running. Lives and dies with the turn.
let activeTurnModel: ActiveTurnModel | null = null;
const pendingExternalTools = new Map<string, PendingExternalTool>();
const serverHandledToolIds = new Set<string>();
// The current pending-queue snapshot, reconciled from remy's queue_changed
// events. Drives the queue dimension of derived busy (see getAgentActivity).
let currentQueue: QueuedMessage[] = [];
// Compaction-in-flight, tracked from remy's compaction_started/complete
// events (cleared on ready/session_restored — compaction never survives a
// remy restart). Drives the third dimension of derived busy: messages sent
// during a compaction queue remy-side, so the sandbox must report busy for
// agentMessage to return {queued:true} and the FE to suppress its optimistic
// bubble.
let compacting = false;

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

export function getAgentActivity(): AgentActivity {
  // Busy is derived: a foreground turn is running OR work that will run on its
  // own is queued OR a compaction is in flight. Keeping it true while the queue
  // has pending work stops the FE (and the HMR flush wired to this signal) from
  // going idle between chained/queued turns; compaction counts because remy
  // queues messages behind it exactly like a running turn.
  //
  // `held` items are excluded — they wait on the user (left behind by a Stop,
  // or restored after a remy restart), so counting them latched the working
  // state on with nothing to stop, which is a large part of why Stop looked
  // broken.
  return {
    busy:
      activity.busy || currentQueue.some((item) => !item.held) || compacting,
    fileOps: [...activity.fileOps],
  };
}

/**
 * Whether a new user message will be QUEUED by remy rather than run at once.
 *
 * Broader than derived busy: held items don't make the agent busy, but a new
 * send folds in with them (remy releases the hold and merges them into one
 * turn), so it comes back as a queued echo rather than an immediate turn.
 */
export function willQueueMessage(): boolean {
  return activity.busy || currentQueue.length > 0 || compacting;
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

/**
 * Flip the compaction-in-flight flag. Broadcasts agentActivityChanged only
 * when the derived busy state actually changes (same pattern as
 * setQueuedMessages).
 */
export function setCompacting(
  value: boolean,
  broadcast: (event: string, data: Record<string, any>) => void,
): void {
  const wasBusy = getAgentActivity().busy;
  compacting = value;
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
  // Drop the previous turn's attribution. actions.ts calls this at send time,
  // before remy's turn_started arrives, so without the reset a turn running on
  // the default would inherit the prior turn's override and show a false rail.
  activeTurnModel = null;
}

/** The requestId of the active foreground turn, or null if none. */
export function getActiveTurnId(): string | null {
  return activeMessageRequestId;
}

/** Track a background turn (no busy state, no activity broadcast). */
export function startBackgroundTurn(requestId: string): void {
  activeMessageRequestId = requestId;
  activeTurnModel = null;
}

/**
 * Record the model attribution remy reported on `turn_started`. Normalizes
 * to null when neither field is present, so an older remy (or a turn with
 * nothing to attribute) doesn't leave an empty object behind that would make
 * us re-emit a contentless event on reconnect.
 */
export function setActiveTurnModel(info: ActiveTurnModel): void {
  activeTurnModel =
    info.model || info.modelOverride
      ? {
          ...(info.model ? { model: info.model } : {}),
          ...(info.modelOverride ? { modelOverride: info.modelOverride } : {}),
        }
      : null;
}

/** Attribution for the in-flight turn, or null if none is known. */
export function getActiveTurnModel(): ActiveTurnModel | null {
  return activeTurnModel;
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
  activeTurnModel = null;
  pendingExternalTools.clear();
  serverHandledToolIds.clear();
  return true;
}

export function clearActivityOnError(): void {
  activity = { busy: false, fileOps: [] };
  activeTurnModel = null;
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
