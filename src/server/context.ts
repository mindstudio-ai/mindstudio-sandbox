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

import type { AppConfig, ServerStatus } from '../types.js';
import type { TunnelSessionState } from '../processes/tunnel/index.js';
import { getSyncStatus } from '../syncStatus.js';
import type { ProcessManager } from '../processes/ProcessManager.js';
import type { ProcessRegistry } from '../processes/ProcessRegistry.js';
import type { BroadcastBatcher } from './server/BroadcastBatcher.js';
import type { EditorStateManager } from './states/EditorStateManager.js';
import type { SpecEditorStateManager } from './states/SpecEditorStateManager.js';
import type { FileTreeManager } from './states/FileTreeManager.js';
import type { SpecFileTreeManager } from './states/SpecFileTreeManager.js';
import type { ResourceMonitor } from '../processes/ResourceMonitor.js';
import type { LspClient } from '../lsp/client.js';
import {
  getAgentHistory,
  getAgentActivity,
  getPendingExternalTools,
} from '../processes/agent/index.js';
import { getActiveSessionIds } from './handlers/pty.js';

export type ViewMode =
  | 'intake'
  | 'preview'
  | 'spec'
  | 'code'
  | 'databases'
  | 'scenarios'
  | 'logs';

export interface ServerContext {
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
  projectHasCode: boolean;
  lspClient: LspClient | null;
  viewMode: ViewMode;
  onFileChanged:
    | ((path: string, changeType: 'created' | 'modified' | 'deleted') => void)
    | null;
  activeImpersonation: string[] | null;
  onUserSave: ((path: string) => void) | null;
}

const VALID_VIEW_MODES: ViewMode[] = [
  'intake',
  'preview',
  'spec',
  'code',
  'databases',
  'scenarios',
  'logs',
];

/** Callback fired when viewMode changes — wired up by index.ts. */
let onViewModeChanged: ((mode: ViewMode) => void) | null = null;

export function setViewModeCallback(cb: (mode: ViewMode) => void): void {
  onViewModeChanged = cb;
}

/** Update the view mode, broadcast to clients, and persist. */
export function setViewMode(mode: string): void {
  if (!VALID_VIEW_MODES.includes(mode as ViewMode)) {
    throw new Error(`Invalid view mode: "${mode}"`);
  }
  if (ctx.viewMode === mode) {
    return;
  }
  ctx.viewMode = mode as ViewMode;
  onViewModeChanged?.(ctx.viewMode);
}

export const ctx: ServerContext = {
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
  projectHasCode: false,
  lspClient: null,
  viewMode: 'intake',
  activeImpersonation: null,
  onFileChanged: null,
  onUserSave: null,
};

// --- Init frame ---

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type InitFrame = Record<string, any>;

/** Build the full init frame. Async because it fetches chat history. */
export async function buildInitFrame(
  proxyAvailable: boolean,
): Promise<InitFrame> {
  const chatHistory = ctx.processManager
    ? await getAgentHistory(ctx.processManager)
    : [];

  return {
    event: 'init',
    status: ctx.status,
    previewAvailable: proxyAvailable,
    app: ctx.appConfig,
    tunnelSession: ctx.tunnelSession,
    activeImpersonation: ctx.activeImpersonation,
    fileTree: ctx.fileTreeManager?.getTree() ?? [],
    chatHistory,
    processes: ctx.registry?.getAllInfo() ?? [],
    outputLog: ctx.registry?.getMergedLog() ?? [],
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
    projectHasCode: ctx.projectHasCode,
    viewMode: ctx.viewMode,
    syncStatus: getSyncStatus(),
    pendingExternalTools: getPendingExternalTools(),
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
    activeImpersonation: ctx.activeImpersonation,
    fileTree: [],
    chatHistory: [],
    processes: [],
    outputLog: [],
    agentActivity: getAgentActivity(),
    ptySessionIds: [],
    editorState: { tabs: [], activeTab: null, expandedDirs: [] },
    specFileTree: [],
    specEditorState: { tabs: [], activeTab: null },
    projectHasCode: ctx.projectHasCode,
    viewMode: ctx.viewMode,
    syncStatus: getSyncStatus(),
    pendingExternalTools: getPendingExternalTools(),
  };
}
