/**
 * Tolerant LOADER for MindStudio-owned JSON config files: parse + repair on disk.
 *
 * The parsing itself lives in `parseJsonConfig.ts`, a pure leaf — see there for
 * the strict-then-JSON5 strategy and why remy's output needs it. This module is
 * the half that touches the filesystem.
 *
 * A single trailing comma used to take the whole sandbox down: readAppConfig
 * returned null, the web interface became undiscoverable, and the dev server
 * never started. Tolerating the slop WITHOUT rewriting would be worse than
 * failing — we aren't the only strict parser of these files (the
 * admin CLI and the server-side deploy pipeline both are), so a
 * lenient-only read just relocates the failure to publish time, far from the
 * edit that caused it. Repairing on disk fixes it for every consumer at once,
 * and the repaired file rides the next workspace snapshot.
 *
 * Strict-first means the steady state never rewrites: no formatting churn and
 * no snapshot noise for files that were already valid.
 *
 * Machine-written state (`.project-status.json`, `.sandbox-state.json`,
 * agent stats) and protocol framing stay on strict JSON.parse — a parse
 * failure there is a bug in our own code, and masking it destroys the signal.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '../logger.ts';
// Imported from the watcher leaf, NOT `fileWatcher/index.js`: that barrel
// imports readAppConfig from bootstrap, and bootstrap imports this module.
import { suppressPath } from '../fileWatcher/watcher.ts';
import { withFileLock } from './fileLock.ts';
import { msg, parseJsonConfig, type ParseResult } from './parseJsonConfig.ts';

// Re-exported so existing importers of this module keep working unchanged.
export { parseJsonConfig, type ParseResult };

const log = createLogger('json-config');

/**
 * Read and parse a config file, repairing it in place when JSON5 rescues a
 * strict-parse failure and `normalize` is set.
 *
 * Serialized per-path against concurrent read-modify-write handlers via the
 * shared file lock. Safe to call from the file-watcher path: `onFileChanged`
 * fires after those handlers release the lock, so there's no re-entrancy.
 */
export async function loadJsonConfigFile<T>(
  absPath: string,
  opts: { normalize?: boolean } = {},
): Promise<ParseResult<T>> {
  return withFileLock(absPath, async () => {
    let raw: string;
    try {
      raw = await fs.readFile(absPath, 'utf-8');
    } catch (err) {
      const notFound =
        typeof err === 'object' &&
        err !== null &&
        (err as { code?: string }).code === 'ENOENT';
      return { ok: false, error: msg(err), notFound } as ParseResult<T>;
    }

    const result = parseJsonConfig<T>(raw);
    if (result.ok && result.repaired && opts.normalize) {
      await normalizeOnDisk(absPath, result.value, result.error);
    }
    return result;
  });
}

/**
 * Rewrite `value` as canonical strict JSON via tmp+rename.
 *
 * tmp+rename rather than a plain write because a crash mid-write leaves a
 * truncated file — the one corruption JSON5 can't rescue. Format matches what
 * setProjectMetadata already writes (2-space, trailing newline), and JSON5
 * preserves key order, so a repair is a minimal diff rather than a reshuffle.
 *
 * Repair failure is non-fatal: we already hold a good parse in memory, so the
 * caller boots either way — it just isn't durable yet.
 */
async function normalizeOnDisk(
  absPath: string,
  value: unknown,
  strictError: string,
): Promise<void> {
  const tmpPath = `${absPath}.tmp-${process.pid}`;
  // Suppress both paths: the rename lands as a 'change' on absPath, and the
  // tmp file itself would otherwise surface as an 'add' in the file tree and
  // schedule a spurious draft snapshot.
  suppressPath(absPath);
  suppressPath(tmpPath);
  try {
    await fs.writeFile(tmpPath, JSON.stringify(value, null, 2) + '\n', 'utf-8');
    await fs.rename(tmpPath, absPath);
    log.warn(
      `Repaired invalid JSON in ${path.basename(absPath)} and rewrote it as strict JSON (was: ${strictError})`,
    );
  } catch (err) {
    log.error(`Failed to normalize ${absPath}: ${msg(err)}`);
    await fs.rm(tmpPath, { force: true }).catch(() => {});
  }
}
