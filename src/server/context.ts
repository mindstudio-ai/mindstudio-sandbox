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
import type { ProcessManager } from '../processes/ProcessManager.js';
import type { ProcessRegistry } from '../processes/ProcessRegistry.js';
import type { BroadcastBatcher } from './server/BroadcastBatcher.js';
import type { EditorStateManager } from './states/EditorStateManager.js';
import type { SpecEditorStateManager } from './states/SpecEditorStateManager.js';
import type { FileTreeManager } from './states/FileTreeManager.js';
import type { SpecFileTreeManager } from './states/SpecFileTreeManager.js';
import type { ResourceMonitor } from '../processes/ResourceMonitor.js';
import type { LspClient } from '../lsp/client.js';
import { getAgentHistory, getAgentActivity } from '../processes/agent/index.js';
import { getActiveSessionIds } from './handlers/pty.js';

export type ViewMode = 'code' | 'spec';

export interface ServerContext {
  status: ServerStatus;
  appConfig: AppConfig | null;
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
}

export const ctx: ServerContext = {
  status: 'bootstrapping',
  appConfig: null,
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
  viewMode: 'code',
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
  };
}

/** Build a minimal fallback init frame (used when history fetch fails). */
export function buildFallbackInitFrame(proxyAvailable: boolean): InitFrame {
  return {
    event: 'init',
    status: ctx.status,
    previewAvailable: proxyAvailable,
    app: ctx.appConfig,
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
  };
}
