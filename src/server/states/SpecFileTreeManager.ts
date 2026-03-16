/**
 * Spec file tree manager.
 *
 * Simplified variant of FileTreeManager that always fully recurses,
 * scoped to src/. No expandedDirs concept — the spec sidebar shows
 * all files in flat sections. Same TreeEntry shape for consistency.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { TreeEntry } from '../../types.js';
import { TREE_HIDDEN } from '../../utils/paths.js';
import { createLogger } from '../../logger.js';

const log = createLogger('spec-file-tree');

const REBUILD_DEBOUNCE_MS = 50;

export interface SpecFileTreeManagerOpts {
  workspaceDir: string;
  onChange: (tree: TreeEntry[]) => void;
}

export class SpecFileTreeManager {
  private workspaceDir: string;
  private onChange: (tree: TreeEntry[]) => void;
  private cachedTree: TreeEntry[] = [];
  private rebuildTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: SpecFileTreeManagerOpts) {
    this.workspaceDir = opts.workspaceDir;
    this.onChange = opts.onChange;
  }

  /** Build the full src/ tree from disk and cache it. */
  async buildTree(): Promise<TreeEntry[]> {
    this.cachedTree = await this.readDir('src');
    return this.cachedTree;
  }

  /** Get the current cached tree (for init frame). */
  getTree(): TreeEntry[] {
    return this.cachedTree;
  }

  /** Called on file watcher events — rebuild if the path is under src/ and structural. */
  onFileChanged(
    filePath: string,
    changeType: 'created' | 'modified' | 'deleted',
  ): void {
    if (!filePath.startsWith('src/')) {
      return;
    }
    // Only structural changes (create/delete) need a tree rebuild
    if (changeType === 'modified') {
      return;
    }
    this.scheduleRebuild();
  }

  private scheduleRebuild(): void {
    if (this.rebuildTimer) {
      return;
    }
    this.rebuildTimer = setTimeout(async () => {
      this.rebuildTimer = null;
      try {
        await this.buildTree();
        this.onChange(this.cachedTree);
      } catch (err) {
        log.debug(
          `Tree rebuild failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    }, REBUILD_DEBOUNCE_MS);
  }

  /** Read a directory and build TreeEntry[] for its children. Always recurses. */
  private async readDir(relDir: string): Promise<TreeEntry[]> {
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

      const relPath = path.join(relDir, entry.name);
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
          node.children = await this.readDir(relPath);
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
