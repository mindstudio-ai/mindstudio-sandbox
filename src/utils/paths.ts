import path from 'node:path';

/** Directories excluded from search and file watching. */
export const IGNORED_DIRS = ['node_modules', '.git', '.vite'] as const;

/** Entries hidden entirely from the file tree. */
export const TREE_HIDDEN = new Set(['.git', '.vite', '.sandbox-state.json']);

/** Directories shown in the file tree but not expanded (collapsed). */
export const TREE_COLLAPSED = new Set(['node_modules']);

/**
 * Resolve a user-provided path against the workspace root.
 * Throws if the resolved path escapes the workspace.
 */
export function resolveSafe(workspaceDir: string, userPath: string): string {
  const resolved = path.resolve(workspaceDir, userPath);
  if (resolved !== workspaceDir && !resolved.startsWith(workspaceDir + '/')) {
    throw new Error('Path escapes workspace');
  }
  return resolved;
}
