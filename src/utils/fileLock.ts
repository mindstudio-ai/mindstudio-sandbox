/**
 * Per-path async lock.
 *
 * Serializes overlapping read-modify-write sequences against the same
 * absolute path. Two handlers (e.g. agent writeFile + FE
 * applyWorkspaceEdits) firing concurrently against the same file will
 * otherwise interleave their fs.readFile/fs.writeFile calls and produce
 * lost-update corruption. Map entries are auto-cleaned when the chain
 * for a path settles.
 *
 * Keyed by absolute path (caller resolves first). Don't pass relative
 * paths — two callers with different cwd assumptions could collide.
 */

const locks = new Map<string, Promise<void>>();

export async function withFileLock<T>(
  absPath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = locks.get(absPath) ?? Promise.resolve();
  let release!: () => void;
  const myLock = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Chain: next caller awaits prev, then myLock. Our release() drops myLock.
  const queued = prev.then(() => myLock);
  locks.set(absPath, queued);

  try {
    await prev;
    return await fn();
  } finally {
    release();
    // If no one queued behind us, drop the entry so the map doesn't grow.
    if (locks.get(absPath) === queued) {
      locks.delete(absPath);
    }
  }
}
