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
import { createLogger } from '../../logger.js';
import { TREE_HIDDEN } from '../../processes/fileWatcher.js';

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

  /** Called on file watcher events — rebuild if the path is under src/. */
  onFileChanged(
    filePath: string,
    changeType: 'created' | 'modified' | 'deleted',
  ): void {
    if (!filePath.startsWith('src/')) {
      return;
    }
    // Structural changes always need a rebuild.
    // Modified .md files also rebuild — frontmatter displayName may have changed.
    if (changeType === 'modified' && !filePath.endsWith('.md')) {
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

  /**
   * Read the `name` field from YAML frontmatter in a markdown file.
   * Returns null if no frontmatter or no name field.
   */
  private async readFrontmatterName(fullPath: string): Promise<string | null> {
    try {
      // Read just the first 512 bytes — frontmatter is always at the top
      const handle = await fs.open(fullPath, 'r');
      const buf = Buffer.alloc(512);
      const { bytesRead } = await handle.read(buf, 0, 512, 0);
      await handle.close();
      const head = buf.toString('utf-8', 0, bytesRead);

      if (!head.startsWith('---')) {
        return null;
      }
      const endIdx = head.indexOf('---', 3);
      if (endIdx === -1) {
        return null;
      }
      const frontmatter = head.slice(3, endIdx);
      const match = frontmatter.match(/^name:\s*(.+)$/m);
      return match ? match[1].trim() : null;
    } catch {
      return null;
    }
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
        } else if (entry.name.endsWith('.md')) {
          const displayName = await this.readFrontmatterName(fullPath);
          if (displayName) {
            node.displayName = displayName;
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
