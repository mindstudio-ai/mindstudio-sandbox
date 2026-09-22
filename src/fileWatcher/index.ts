import fs from 'node:fs/promises';
import path from 'node:path';
import type { Config } from '../config.ts';
import type { BroadcastBatcher } from '../server/BroadcastBatcher.ts';
import type { EditorStateManager } from '../server/states/EditorStateManager.ts';
import type { FileTreeManager } from '../server/states/FileTreeManager.ts';
import type { SpecFileTreeManager } from '../server/states/SpecFileTreeManager.ts';
import type { SpecEditorStateManager } from '../server/states/SpecEditorStateManager.ts';
import type { LspSidecar } from '../lsp/sidecar.ts';
// AppConfig type removed — setupFileWatcher reads from ctx.appConfig directly
import { ctx } from '../server/context.ts';
import { broadcast } from '../server/index.ts';
import { readAppConfig } from '../bootstrap/index.ts';
import { startWatcher } from './watcher.ts';
export {
  stopWatcher,
  suppressPath,
  TREE_HIDDEN,
  TREE_HIDDEN_WATCHED,
  TREE_COLLAPSED,
} from './watcher.ts';
import {
  getProjectStatus,
  reloadProjectStatus,
} from '../projectStatus/ProjectStatusManager.ts';
import { readAgentStats } from '../processes/agent/agentStats.ts';
import { readAppBrand } from '../projectStatus/appBrand.ts';
import { createLogger } from '../logger.ts';

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

    // Project status — re-read on external writes (e.g. remy writing the
    // file directly, or a snapshot restore overwriting it). In-process
    // mutations via setOnboardingState already broadcast and flush, so the
    // subsequent watcher event is a no-op (reloadProjectStatus returns false).
    if (filePath === '.project-status.json' && changeType !== 'deleted') {
      if (reloadProjectStatus()) {
        broadcast('projectStatusChanged', getProjectStatus());
      }
    }

    // Agent stats — remy rewrites .remy-stats.json once per turn, so
    // just read and broadcast on every change.
    if (filePath === '.remy-stats.json') {
      if (changeType === 'deleted') {
        broadcast('agentStatsChanged', { stats: null });
      } else {
        // readAgentStats swallows read errors and resolves null — don't
        // broadcast that as an affirmative "no stats"; only a delete clears.
        readAgentStats(config.workspaceDir)
          .then((stats) => {
            if (stats) {
              broadcast('agentStatsChanged', { stats });
            }
          })
          .catch(() => {});
      }
    }

    // App brand — extractor writes .remy-brand.json atomically on each
    // change. Whole-object pass-through; frontend owns the schema.
    if (filePath === '.remy-brand.json') {
      if (changeType === 'deleted') {
        broadcast('appBrandChanged', { brand: null });
      } else {
        // Same as stats: readAppBrand resolves null on any read error, and
        // the brand is rewritten rarely — a null broadcast here would strip
        // the UI's brand until refresh. Only a delete clears.
        readAppBrand(config.workspaceDir)
          .then((brand) => {
            if (brand) {
              broadcast('appBrandChanged', { brand });
            }
          })
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
