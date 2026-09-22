/**
 * Spec file tree manager.
 *
 * Simplified variant of FileTreeManager that always fully recurses,
 * scoped to src/. No expandedDirs concept — the spec sidebar shows
 * all files in flat sections. Same TreeEntry shape for consistency.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { TreeEntry } from '../../types.ts';
import { createLogger } from '../../logger.ts';
import { TREE_HIDDEN, TREE_HIDDEN_WATCHED } from '../../fileWatcher/index.ts';

const log = createLogger('spec-tree');

const REBUILD_DEBOUNCE_MS = 50;

/**
 * How much of a markdown file to read looking for its frontmatter block.
 *
 * Has to clear the largest real block by a margin: a block that overruns the
 * window has no closing fence in view, so the file silently loses EVERY field
 * rather than losing one. Real roadmap items (long quoted names plus a
 * paragraph-length description) have been measured up to ~850 bytes.
 */
const FRONTMATTER_HEAD_BYTES = 2048;

export interface SpecFileTreeManagerOpts {
  workspaceDir: string;
  onChange: (tree: TreeEntry[]) => void;
  getAppName: () => string | null;
}

export class SpecFileTreeManager {
  private workspaceDir: string;
  private onChange: (tree: TreeEntry[]) => void;
  private getAppName: () => string | null;
  private cachedTree: TreeEntry[] = [];
  private rebuildTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: SpecFileTreeManagerOpts) {
    this.workspaceDir = opts.workspaceDir;
    this.onChange = opts.onChange;
    this.getAppName = opts.getAppName;
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
   * Parse YAML frontmatter from a markdown file.
   * Returns null if no frontmatter block found.
   * Uses lightweight line-by-line parsing (no YAML library dependency).
   *
   * Two sibling implementations must stay in sync with these semantics:
   *   - remy-frontend `app/resources/helpers/parseFrontmatter.ts`
   *   - youai-api `src/common/Db/v2Apps/_helpers/presentationArtifacts.ts`
   *     (`parseFrontmatter`)
   * Separate repos, so the code can't be shared. Change all three together.
   */
  private async readFrontmatter(
    fullPath: string,
  ): Promise<Record<string, unknown> | null> {
    try {
      // Frontmatter is always at the top, so only the head is read.
      const handle = await fs.open(fullPath, 'r');
      const buf = Buffer.alloc(FRONTMATTER_HEAD_BYTES);
      const { bytesRead } = await handle.read(
        buf,
        0,
        FRONTMATTER_HEAD_BYTES,
        0,
      );
      await handle.close();
      const head = buf.toString('utf-8', 0, bytesRead);

      if (!head.startsWith('---')) {
        return null;
      }
      const endIdx = head.indexOf('---', 3);
      if (endIdx === -1) {
        return null;
      }
      const block = head.slice(3, endIdx).trim();
      if (!block) {
        return null;
      }

      const result: Record<string, unknown> = {};
      for (const line of block.split('\n')) {
        const colonIdx = line.indexOf(':');
        if (colonIdx === -1) {
          continue;
        }
        const key = line.slice(0, colonIdx).trim();
        let value: unknown = line.slice(colonIdx + 1).trim();

        // Parse YAML-ish values
        if (typeof value === 'string') {
          if (value === 'true') {
            value = true;
          } else if (value === 'false') {
            value = false;
          } else if (value === '[]') {
            value = [];
          } else if (
            (value as string).startsWith('[') &&
            (value as string).endsWith(']')
          ) {
            // Simple inline array: [foo, bar] or ["foo", "bar"]
            value = (value as string)
              .slice(1, -1)
              .split(',')
              .map((s) => s.trim().replace(/^["']|["']$/g, ''))
              .filter(Boolean);
          } else {
            // Scalar. Anything containing a colon gets quoted by whoever
            // authored it (`name: "Registry: Phase 2"`), and the quotes are
            // not part of the value — without this they reach the UI verbatim.
            value = (value as string)
              .replace(/^"(.*)"$/s, '$1')
              .replace(/^'(.*)'$/s, '$1');
          }
        }

        result[key] = value;
      }
      return Object.keys(result).length > 0 ? result : null;
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
      if (TREE_HIDDEN.has(entry.name) || TREE_HIDDEN_WATCHED.has(entry.name)) {
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
          const fm = await this.readFrontmatter(fullPath);
          if (fm) {
            node.frontmatter = fm;
            if (typeof fm.name === 'string') {
              node.displayName = fm.name;
            }
          }
          if (!node.displayName && relPath === 'src/app.md') {
            // Fall back to app name from mindstudio.json for the main spec file
            node.displayName = this.getAppName() ?? undefined;
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
