import chokidar, { type FSWatcher } from 'chokidar';
import path from 'node:path';

// Directories excluded from file watching.
const IGNORED_DIRS = ['node_modules', '.git', '.vite'] as const;

// Entries hidden entirely from the file tree.
export const TREE_HIDDEN = new Set([
  '.git',
  '.vite',
  '.sandbox-state.json',
  '.remy-session.json',
  '.sync-status.json',
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
  onChange: (
    filePath: string,
    changeType: 'created' | 'modified' | 'deleted',
  ) => void,
): void {
  workspaceDir = dir;

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

  watcher = chokidar.watch(dir, {
    ignored: [
      ...IGNORED_DIRS.map((d) => `**/${d}/**`),
      ...Array.from(TREE_HIDDEN).map((name) => `**/${name}`),
    ],
    ignoreInitial: true,
    persistent: true,
    awaitWriteFinish: {
      stabilityThreshold: 100,
      pollInterval: 50,
    },
  });

  function shouldEmit(absPath: string): boolean {
    if (isSuppressed(absPath)) {
      return false;
    }
    // Don't emit events for hidden files (e.g. .sandbox-state.json)
    if (TREE_HIDDEN.has(path.basename(absPath))) {
      return false;
    }
    return true;
  }

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
