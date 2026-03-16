/**
 * Server-owned file tree manager.
 *
 * Maintains the visible file tree — the set of entries that should be
 * rendered given the current expandedDirs. Only expanded branches are
 * read from disk. On every expand/collapse or file change, the tree is
 * rebuilt (debounced) and broadcast to clients. Frontend just renders
 * what it receives.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { TreeEntry } from '../../types.js';
import { createLogger } from '../../logger.js';
import { TREE_COLLAPSED, TREE_HIDDEN } from '../../processes/fileWatcher.js';

const log = createLogger('file-tree');

const REBUILD_DEBOUNCE_MS = 50;

export interface FileTreeManagerOpts {
  workspaceDir: string;
  getExpandedDirs: () => Set<string>;
  onChange: (tree: TreeEntry[]) => void;
}

export class FileTreeManager {
  private workspaceDir: string;
  private getExpandedDirs: () => Set<string>;
  private onChange: (tree: TreeEntry[]) => void;
  private cachedTree: TreeEntry[] = [];
  private rebuildTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: FileTreeManagerOpts) {
    this.workspaceDir = opts.workspaceDir;
    this.getExpandedDirs = opts.getExpandedDirs;
    this.onChange = opts.onChange;
  }

  /** Build the full visible tree from disk and cache it. */
  async buildVisibleTree(): Promise<TreeEntry[]> {
    this.cachedTree = await this.readDir('.', this.getExpandedDirs());
    return this.cachedTree;
  }

  /** Get the current cached tree (for init frame). */
  getTree(): TreeEntry[] {
    return this.cachedTree;
  }

  /** Called when expandedDirs changes — schedule rebuild. */
  onExpandedDirsChanged(): void {
    this.scheduleRebuild();
  }

  /** Called on file watcher events — rebuild if the affected dir is visible. */
  onFileChanged(
    filePath: string,
    changeType: 'created' | 'modified' | 'deleted',
  ): void {
    // Only structural changes (create/delete) need a tree rebuild.
    // Modified files don't change the tree structure.
    if (changeType === 'modified') {
      return;
    }

    const parentDir = path.dirname(filePath);
    const expandedDirs = this.getExpandedDirs();

    // Visible if parent is root or parent is expanded
    if (parentDir === '.' || expandedDirs.has(parentDir)) {
      this.scheduleRebuild();
    }
  }

  private scheduleRebuild(): void {
    if (this.rebuildTimer) {
      return;
    }
    this.rebuildTimer = setTimeout(async () => {
      this.rebuildTimer = null;
      try {
        await this.buildVisibleTree();
        this.onChange(this.cachedTree);
      } catch (err) {
        log.debug(
          `Tree rebuild failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    }, REBUILD_DEBOUNCE_MS);
  }

  /** Read a directory and build TreeEntry[] for its children. */
  private async readDir(
    relDir: string,
    expandedDirs: Set<string>,
  ): Promise<TreeEntry[]> {
    const absDir = path.resolve(this.workspaceDir, relDir);
    let entries;
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      return [];
    }

    const results: TreeEntry[] = [];

    for (const entry of entries) {
      if (TREE_HIDDEN.has(entry.name)) {
        continue;
      }

      const relPath =
        relDir === '.' ? entry.name : path.join(relDir, entry.name);
      const fullPath = path.join(absDir, entry.name);

      try {
        const stat = await fs.stat(fullPath);
        const node: TreeEntry = {
          name: entry.name,
          path: relPath,
          type: entry.isDirectory() ? 'directory' : 'file',
          size: stat.size,
          modified: stat.mtime.toISOString(),
        };

        if (entry.isDirectory()) {
          if (TREE_COLLAPSED.has(entry.name)) {
            node.collapsed = true;
          } else if (expandedDirs.has(relPath)) {
            node.children = await this.readDir(relPath, expandedDirs);
          }
        }

        results.push(node);
      } catch {
        // Skip entries we can't stat
      }
    }

    // Sort: directories first, then alphabetical
    results.sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === 'directory' ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });

    return results;
  }
}
