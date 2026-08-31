/**
 * Shared server context and init frame.
 *
 * ctx: Single mutable object that holds all the refs that various
 * server modules need. Bootstrap (index.ts) populates the fields;
 * handlers read from them.
 *
 * buildInitFrame / buildFallbackInitFrame: Construct the payload sent
 * to WebSocket clients on connection.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '../logger.js';
import type { AppConfig, ServerStatus } from '../types.js';
import type { TunnelSessionState } from '../processes/tunnel/index.js';
import { getSandboxBrowserState } from '../processes/tunnel/index.js';
import type { InstallFailure } from '../bootstrap/index.js';
import { getProjectStatus } from '../projectStatus/ProjectStatusManager.js';
import type { ProcessManager } from '../processes/ProcessManager.js';
import type { ProcessRegistry } from '../processes/ProcessRegistry.js';
import type { BroadcastBatcher } from './BroadcastBatcher.js';
import type { EditorStateManager } from './states/EditorStateManager.js';
import type { SpecEditorStateManager } from './states/SpecEditorStateManager.js';
import type { FileTreeManager } from './states/FileTreeManager.js';
import type { SpecFileTreeManager } from './states/SpecFileTreeManager.js';
import type { ResourceMonitor } from '../processes/ResourceMonitor.js';
import type { LspClient } from '../lsp/client.js';
import type { DraftSnapshotManager } from '../projectStatus/DraftSnapshotManager.js';
import { getAgentHistory, getAgentActivity } from '../processes/agent/index.js';
import {
  readAgentStats,
  type AgentStats,
} from '../processes/agent/agentStats.js';
import { readAppBrand, type AppBrand } from '../projectStatus/appBrand.js';
import { getActiveSessionIds } from './wsHandlers/pty.js';

export interface ServerContext {
  workspaceDir: string | null;
  status: ServerStatus;
  appConfig: AppConfig | null;
  tunnelSession: TunnelSessionState | null;
  processManager: ProcessManager | null;
  batcher: BroadcastBatcher | null;
  registry: ProcessRegistry | null;
  editorState: EditorStateManager | null;
  specEditorState: SpecEditorStateManager | null;
  resourceMonitor: ResourceMonitor | null;
  fileTreeManager: FileTreeManager | null;
  specFileTreeManager: SpecFileTreeManager | null;
  lspClient: LspClient | null;
  snapshotManager: DraftSnapshotManager | null;
  onFileChanged:
    | ((path: string, changeType: 'created' | 'modified' | 'deleted') => void)
    | null;
  onProjectStatusChanged: (() => void) | null;
  /**
   * Set if `npm install` failed for one or more app package directories
   * during bootstrap. Sandbox boots in degraded mode (no dev server) so
   * the user can recover from the terminal. Null on a clean install.
   */
  installFailures: InstallFailure[] | null;
}

export const ctx: ServerContext = {
  workspaceDir: null,
  status: 'bootstrapping',
  appConfig: null,
  tunnelSession: null,
  processManager: null,
  batcher: null,
  registry: null,
  editorState: null,
  specEditorState: null,
  resourceMonitor: null,
  fileTreeManager: null,
  specFileTreeManager: null,
  lspClient: null,
  snapshotManager: null,
  onFileChanged: null,
  onProjectStatusChanged: null,
  installFailures: null,
};

// --- Init frame ---

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type InitFrame = Record<string, any>;

const log = createLogger('init-frame');

/** Build the full init frame. Async because it fetches chat history. */
export async function buildInitFrame(
  proxyAvailable: boolean,
): Promise<InitFrame> {
  const historyResult = ctx.processManager
    ? await getAgentHistory(ctx.processManager)
    : { messages: [] };
  log.info('History fetched for init frame', {
    messages: historyResult.messages.length,
    startIndex:
      'startIndex' in historyResult ? historyResult.startIndex : undefined,
    endIndex: 'endIndex' in historyResult ? historyResult.endIndex : undefined,
    totalMessageCount:
      'totalMessageCount' in historyResult
        ? historyResult.totalMessageCount
        : undefined,
    running: 'running' in historyResult ? historyResult.running : undefined,
  });

  let plan: string | null = null;
  if (ctx.workspaceDir) {
    try {
      plan = await fs.readFile(
        path.join(ctx.workspaceDir, '.remy-plan.md'),
        'utf-8',
      );
    } catch {
      // file doesn't exist
    }
  }

  let agentStats: AgentStats | null = null;
  if (ctx.workspaceDir) {
    agentStats = await readAgentStats(ctx.workspaceDir);
  }

  let appBrand: AppBrand | null = null;
  if (ctx.workspaceDir) {
    appBrand = await readAppBrand(ctx.workspaceDir);
  }

  return {
    event: 'init',
    status: ctx.status,
    previewAvailable: proxyAvailable,
    app: ctx.appConfig,
    tunnelSession: ctx.tunnelSession,
    fileTree: ctx.fileTreeManager?.getTree() ?? [],
    chatHistory: historyResult.messages,
    chatHistoryStartIndex:
      typeof historyResult.startIndex === 'number'
        ? historyResult.startIndex
        : null,
    chatHistoryEndIndex:
      typeof historyResult.endIndex === 'number'
        ? historyResult.endIndex
        : null,
    chatHistoryTotalCount:
      typeof historyResult.totalMessageCount === 'number'
        ? historyResult.totalMessageCount
        : null,
    // Per-agent model picks active on the current session. Sparse — keys
    // present here override defaults; absent keys mean "server default
    // for that agent." Null when remy didn't return a models field (older
    // remy versions, or no per-session overrides set).
    agentModels:
      historyResult.models && typeof historyResult.models === 'object'
        ? historyResult.models
        : null,
    // Picker registry shipped by remy — the authoritative source for
    // surface keys, labels, descriptions, defaults, modelType, and
    // userPickable. Always populated from current remy; null on older
    // remy that doesn't ship the registry over the wire.
    agentModelSurfaces:
      historyResult.modelSurfaces &&
      typeof historyResult.modelSurfaces === 'object'
        ? historyResult.modelSurfaces
        : null,
    // Per-modelType allow-list (today: only 'text' is constrained).
    // Frontend uses this to bound dropdowns for text surfaces; absent
    // types are unconstrained and curated from the FE's catalog.
    agentAllowedModelsByType:
      historyResult.allowedModelsByType &&
      typeof historyResult.allowedModelsByType === 'object'
        ? historyResult.allowedModelsByType
        : null,
    // Pending message queue snapshot — seed on connect/reconnect, then
    // reconcile to the agentQueueChanged broadcast for live updates.
    //
    // `null` means "no snapshot to report" (remy not running, get_history
    // failed), which is NOT the same as `[]` ("remy says the queue is empty").
    // The frontend keeps what it holds on null: a paused build pipeline is idle,
    // so an empty frame on a reconnect blip would otherwise wipe it off screen
    // and nothing re-broadcasts until the queue next mutates — which for a
    // parked pipeline may be never.
    queuedMessages:
      'queuedMessages' in historyResult && historyResult.queuedMessages
        ? historyResult.queuedMessages
        : null,
    ...(historyResult.running ? { agentRunning: true } : {}),
    ...(historyResult.currentRequestId
      ? { agentCurrentRequestId: historyResult.currentRequestId }
      : {}),
    processes: ctx.registry?.getAllInfo() ?? [],
    agentActivity: getAgentActivity(),
    ptySessionIds: getActiveSessionIds(),
    editorState: ctx.editorState?.getState() ?? {
      tabs: [],
      activeTab: null,
      expandedDirs: [],
    },
    specFileTree: ctx.specFileTreeManager?.getTree() ?? [],
    specEditorState: ctx.specEditorState?.getState() ?? {
      tabs: [],
      activeTab: null,
    },
    projectStatus: getProjectStatus(),
    plan,
    agentStats,
    appBrand,
    sandboxBrowser: getSandboxBrowserState(),
    installFailures: ctx.installFailures,
  };
}

/** Build a minimal fallback init frame (used when history fetch fails). */
export function buildFallbackInitFrame(proxyAvailable: boolean): InitFrame {
  return {
    event: 'init',
    status: ctx.status,
    previewAvailable: proxyAvailable,
    app: ctx.appConfig,
    tunnelSession: ctx.tunnelSession,
    fileTree: [],
    chatHistory: [],
    chatHistoryStartIndex: null,
    chatHistoryEndIndex: null,
    chatHistoryTotalCount: null,
    agentModels: null,
    agentModelSurfaces: null,
    agentAllowedModelsByType: null,
    // See buildInitFrame — null is "unknown", not "empty".
    queuedMessages: null,
    processes: [],
    agentActivity: getAgentActivity(),
    ptySessionIds: [],
    editorState: { tabs: [], activeTab: null, expandedDirs: [] },
    specFileTree: [],
    specEditorState: { tabs: [], activeTab: null },
    projectStatus: getProjectStatus(),
    agentStats: null,
    appBrand: null,
    sandboxBrowser: getSandboxBrowserState(),
    installFailures: ctx.installFailures,
  };
}
