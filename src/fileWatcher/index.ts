import fs from 'node:fs/promises';
import path from 'node:path';
import type { Config } from '../config.js';
import type { BroadcastBatcher } from '../server/BroadcastBatcher.js';
import type { EditorStateManager } from '../server/states/EditorStateManager.js';
import type { FileTreeManager } from '../server/states/FileTreeManager.js';
import type { SpecFileTreeManager } from '../server/states/SpecFileTreeManager.js';
import type { SpecEditorStateManager } from '../server/states/SpecEditorStateManager.js';
import type { LspSidecar } from '../lsp/sidecar.js';
// AppConfig type removed — setupFileWatcher reads from ctx.appConfig directly
import { ctx } from '../server/context.js';
import { broadcast } from '../server/index.js';
import { readAppConfig } from '../bootstrap/index.js';
import { startWatcher } from './watcher.js';
export {
  stopWatcher,
  suppressPath,
  TREE_HIDDEN,
  TREE_HIDDEN_WATCHED,
  TREE_COLLAPSED,
} from './watcher.js';
import { getProjectStatus } from '../projectStatus/ProjectStatusManager.js';
import { readAgentStats } from '../processes/agent/agentStats.js';
import { createLogger } from '../logger.js';

const log = createLogger('fileWatcher');

interface FileWatcherManagers {
  batcher: BroadcastBatcher;
  editorManager: EditorStateManager;
  specEditorManager: SpecEditorStateManager;
  fileTreeManager: FileTreeManager;
  specFileTreeManager: SpecFileTreeManager;
}

export function setupFileWatcher(
  config: Config,
  managers: FileWatcherManagers,
  lspSidecar: LspSidecar,
): void {
  const {
    batcher,
    editorManager,
    specEditorManager,
    fileTreeManager,
    specFileTreeManager,
  } = managers;

  // Shared handler for all file change events — called by both the
  // file watcher (for external/user changes) and the writeFile/deleteFile/
  // renameFile handlers (where watcher events are suppressed).
  function handleFileChanged(
    filePath: string,
    changeType: 'created' | 'modified' | 'deleted',
  ): void {
    batcher.push('fileChanged', { path: filePath, changeType });

    if (changeType === 'modified' || changeType === 'created') {
      lspSidecar.onFileChanged(filePath).catch(() => {});

      // Re-read and broadcast app config when manifest or any interface
      // config file changes (e.g. web.json, cron.json).
      const isInterfaceConfig = ctx.appConfig?.interfaces.some(
        (i) => i.path === filePath,
      );
      if (filePath === 'mindstudio.json' || isInterfaceConfig) {
        readAppConfig(config.workspaceDir)
          .then((updated) => {
            if (updated) {
              ctx.appConfig = updated;
              broadcast('manifestChanged', { app: updated });
            }
          })
          .catch(() => {});
      }
    }

    if (changeType === 'deleted') {
      lspSidecar.onFileDeleted(filePath);
      editorManager.onFileDeleted(filePath);
      specEditorManager.onFileDeleted(filePath);
    }

    // Plan file changes
    if (filePath === '.remy-plan.md') {
      if (changeType === 'deleted') {
        broadcast('planChanged', { plan: null });
      } else {
        fs.readFile(path.join(config.workspaceDir, filePath), 'utf-8')
          .then((content) => broadcast('planChanged', { plan: content }))
          .catch(() => {});
      }
    }

    // Agent stats — remy rewrites .remy-stats.json once per turn, so
    // just read and broadcast on every change.
    if (filePath === '.remy-stats.json') {
      if (changeType === 'deleted') {
        broadcast('agentStatsChanged', { stats: null });
      } else {
        readAgentStats(config.workspaceDir)
          .then((stats) => broadcast('agentStatsChanged', { stats }))
          .catch(() => {});
      }
    }

    fileTreeManager.onFileChanged(filePath, changeType);

    // Spec file tree updates
    if (filePath.startsWith('src/')) {
      specFileTreeManager.onFileChanged(filePath, changeType);
    }
  }

  // Expose so handlers can call it for suppressed writes
  ctx.onFileChanged = handleFileChanged;

  // Broadcast project status changes (onboarding state set by user)
  ctx.onProjectStatusChanged = () => {
    broadcast('projectStatusChanged', getProjectStatus());
  };

  log.info(`Starting file watcher on ${config.workspaceDir}`);
  startWatcher(config.workspaceDir, handleFileChanged);
}
