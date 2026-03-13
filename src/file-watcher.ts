import chokidar, { type FSWatcher } from 'chokidar';
import path from 'node:path';

let watcher: FSWatcher | null = null;
let workspaceDir: string;

// Write suppression to avoid feedback loops
const suppressedPaths = new Map<string, number>();

const SUPPRESS_TTL = 2000;

export function suppressPath(filePath: string): void {
  suppressedPaths.set(filePath, Date.now());
}

function isSuppressed(filePath: string): boolean {
  const ts = suppressedPaths.get(filePath);
  if (!ts) return false;
  if (Date.now() - ts > SUPPRESS_TTL) {
    suppressedPaths.delete(filePath);
    return false;
  }
  suppressedPaths.delete(filePath);
  return true;
}

export function startWatcher(
  dir: string,
  onChange: (filePath: string, changeType: 'created' | 'modified' | 'deleted') => void,
): void {
  workspaceDir = dir;

  watcher = chokidar.watch(dir, {
    ignored: [
      '**/node_modules/**',
      '**/.git/**',
      '**/.vite/**',
    ],
    ignoreInitial: true,
    persistent: true,
    awaitWriteFinish: {
      stabilityThreshold: 100,
      pollInterval: 50,
    },
  });

  watcher.on('add', (absPath) => {
    if (isSuppressed(absPath)) return;
    onChange(path.relative(workspaceDir, absPath), 'created');
  });

  watcher.on('change', (absPath) => {
    if (isSuppressed(absPath)) return;
    onChange(path.relative(workspaceDir, absPath), 'modified');
  });

  watcher.on('unlink', (absPath) => {
    if (isSuppressed(absPath)) return;
    onChange(path.relative(workspaceDir, absPath), 'deleted');
  });
}

export function stopWatcher(): void {
  watcher?.close();
  watcher = null;
}
