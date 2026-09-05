import chokidar, { type FSWatcher } from 'chokidar';
import path from 'node:path';
import { createLogger } from '../logger.js';
import { recordActivity } from '../activity.js';

const log = createLogger('file-watcher');

// Directories excluded from file watching.
const IGNORED_DIRS = ['node_modules', '.git', '.vite', '.logs'] as const;

// Entries hidden from the file tree AND ignored by the watcher.
export const TREE_HIDDEN = new Set([
  '.git',
  '.vite',
  '.logs',
  '.sandbox-state.json',
  '.remy-session.json',
  '.remy-brand.cache.json',
  '.remy-design-sample.json',
]);

// Entries hidden from the file tree but still watched, so we can react to
// changes (e.g. broadcast agent stats derived from .remy-stats.json,
// brand info from .remy-brand.json, project status from
// .project-status.json).
export const TREE_HIDDEN_WATCHED = new Set([
  '.remy-stats.json',
  '.remy-brand.json',
  '.project-status.json',
]);

// Directories shown in the file tree but not expanded (collapsed).
export const TREE_COLLAPSED = new Set(['node_modules']);

let watcher: FSWatcher | null = null;
let cleanupTimer: ReturnType<typeof setInterval> | null = null;
let workspaceDir: string;

// Write suppression to avoid feedback loops
const suppressedPaths = new Map<string, number>();

const SUPPRESS_TTL = 2000;

export function suppressPath(filePath: string): void {
  suppressedPaths.set(filePath, Date.now());
}

function isSuppressed(filePath: string): boolean {
  const ts = suppressedPaths.get(filePath);
  if (!ts) {
    return false;
  }
  if (Date.now() - ts > SUPPRESS_TTL) {
    suppressedPaths.delete(filePath);
    return false;
  }
  return true;
}

export function startWatcher(
  dir: string,
  rawOnChange: (
    filePath: string,
    changeType: 'created' | 'modified' | 'deleted',
  ) => void,
): void {
  workspaceDir = dir;

  // All five watcher events funnel through here, so this is the one place that has to count them.
  //
  // File changes are activity with no inbound request behind them — an agent writing files, a git
  // operation, a build emitting output. A reaper that only watched editor traffic would kill a box
  // in the middle of an agent turn, which is precisely when nobody is typing.
  const onChange: typeof rawOnChange = (filePath, changeType) => {
    recordActivity('fs');
    rawOnChange(filePath, changeType);
  };

  // Periodically clean stale suppression entries
  cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [filePath, ts] of suppressedPaths) {
      if (now - ts > SUPPRESS_TTL) {
        suppressedPaths.delete(filePath);
      }
    }
  }, 30_000);
  cleanupTimer.unref();

  const ignoredNames = new Set([...IGNORED_DIRS, ...TREE_HIDDEN]);
  watcher = chokidar.watch(dir, {
    ignored: (filePath: string) => {
      const base = path.basename(filePath);
      return ignoredNames.has(base);
    },
    ignoreInitial: true,
    persistent: true,
  });

  function shouldEmit(absPath: string): boolean {
    return !isSuppressed(absPath);
  }

  watcher.on('error', (err: unknown) => {
    log.error(
      `File watcher error: ${err instanceof Error ? err.message : err}`,
    );
  });

  watcher.on('add', (absPath) => {
    if (!shouldEmit(absPath)) {
      return;
    }
    onChange(path.relative(workspaceDir, absPath), 'created');
  });

  watcher.on('change', (absPath) => {
    if (!shouldEmit(absPath)) {
      return;
    }
    onChange(path.relative(workspaceDir, absPath), 'modified');
  });

  watcher.on('unlink', (absPath) => {
    if (!shouldEmit(absPath)) {
      return;
    }
    onChange(path.relative(workspaceDir, absPath), 'deleted');
  });

  watcher.on('addDir', (absPath) => {
    if (!shouldEmit(absPath)) {
      return;
    }
    onChange(path.relative(workspaceDir, absPath), 'created');
  });

  watcher.on('unlinkDir', (absPath) => {
    if (!shouldEmit(absPath)) {
      return;
    }
    onChange(path.relative(workspaceDir, absPath), 'deleted');
  });
}

export function stopWatcher(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
  watcher?.close();
  watcher = null;
}
