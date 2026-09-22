/**
 * Write suppression for the workspace watcher.
 *
 * A path this process writes — an editor save, a JSON repair — comes straight
 * back as a chokidar event; suppressing it for a moment is what stops the
 * feedback loop.
 *
 * A leaf on purpose. `utils/jsonConfig.ts` needs `suppressPath` for its repair
 * rewrite and is imported by the dev tunnel too, which must not load chokidar
 * (`watcher.ts`) as a side effect of parsing a config file. In the tunnel this
 * map is simply never read.
 */

const suppressedPaths = new Map<string, number>();

const SUPPRESS_TTL = 2000;

export function suppressPath(filePath: string): void {
  suppressedPaths.set(filePath, Date.now());
}

export function isSuppressed(filePath: string): boolean {
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

/** Drop expired entries that no event ever came back to query. */
export function pruneSuppressed(): void {
  const now = Date.now();
  for (const [filePath, ts] of suppressedPaths) {
    if (now - ts > SUPPRESS_TTL) {
      suppressedPaths.delete(filePath);
    }
  }
}
