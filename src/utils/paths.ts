import path from 'node:path';

/** Directories excluded from file trees, search, and file watching. */
export const IGNORED_DIRS = ['node_modules', '.git', '.vite'] as const;

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
