import fs from 'node:fs/promises';
import path from 'node:path';
import type { Config } from '../config.ts';
import type { BroadcastBatcher } from '../server/BroadcastBatcher.ts';
import type { EditorStateManager } from '../server/states/EditorStateManager.ts';
import type { FileTreeManager } from '../server/states/FileTreeManager.ts';
import type { SpecFileTreeManager } from '../server/states/SpecFileTreeManager.ts';
import type { SpecEditorStateManager } from '../server/states/SpecEditorStateManager.ts';
import type { LspSidecar } from '../lsp/sidecar.ts';
import { ctx } from '../server/context.ts';
import { broadcast } from '../server/index.ts';
import { refreshAppConfig } from '../server/refreshAppConfig.ts';
import {
  notifyConfigFileChanged,
  notifyTableFileChanged,
} from '../processes/tunnel/index.ts';
import { startWatcher } from './watcher.ts';
export {
  stopWatcher,
  TREE_HIDDEN,
  TREE_HIDDEN_WATCHED,
  TREE_COLLAPSED,
} from './watcher.ts';
export { suppressPath } from './suppress.ts';
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

    const isManifest = filePath === 'mindstudio.json';
    const iface = ctx.appConfig?.interfaces.find((i) => i.path === filePath);

    if (changeType === 'modified' || changeType === 'created') {
      lspSidecar.onFileChanged(filePath).catch(() => {});

      // The manifest, or an interface config it references (web.json,
      // cron.json…): re-read and tell the editor.
      if (isManifest || iface) {
        void refreshAppConfig();
      }
    }

    if (changeType === 'deleted') {
      lspSidecar.onFileDeleted(filePath);
      editorManager.onFileDeleted(filePath);
      specEditorManager.onFileDeleted(filePath);
    }

    // The tunnel's turn, on every change type — a deleted manifest is a
    // `config-error` it should get to report. It used to watch these files with
    // two chokidar trees of its own over this same workspace, which also saw
    // this process's JSON repairs as edits and restarted the session for them.
    // One watcher now, and `suppressPath` covers every consumer of it. Only
    // enabled interfaces: a disabled one's config is not part of the session.
    if (ctx.processManager) {
      if (isManifest || (iface && iface.enabled !== false)) {
        notifyConfigFileChanged(
          ctx.processManager,
          path.join(config.workspaceDir, filePath),
        );
      }
      if (ctx.appConfig?.tables.some((t) => t.path === filePath)) {
        notifyTableFileChanged(ctx.processManager);
      }
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
