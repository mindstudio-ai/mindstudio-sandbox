/**
 * Tolerant loader for MindStudio-owned JSON config files.
 *
 * App configs (`mindstudio.json`, interface configs like `web.json`) are
 * authored by remy, so they pick up the usual LLM-JSON slop — most often a
 * trailing comma left behind when an array entry is deleted. A single one of
 * those used to take the whole sandbox down: readAppConfig returned null, the
 * web interface became undiscoverable, and the dev server never started.
 *
 * Strategy: strict JSON.parse first, JSON5 as a rescue, then rewrite the file
 * as canonical strict JSON. Tolerating the slop WITHOUT rewriting would be
 * worse than failing — we aren't the only strict parser of these files (the
 * `mindstudio-prod` CLI and the server-side deploy pipeline both are), so a
 * lenient-only read just relocates the failure to publish time, far from the
 * edit that caused it. Repairing on disk fixes it for every consumer at once,
 * and the repaired file rides the next `_draft` snapshot.
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
import JSON5 from 'json5';
import { createLogger } from '../logger.js';
// Imported from the watcher leaf, NOT `fileWatcher/index.js`: that barrel
// imports readAppConfig from bootstrap, and bootstrap imports this module.
import { suppressPath } from '../fileWatcher/watcher.js';
import { withFileLock } from './fileLock.js';

const log = createLogger('json-config');

export type ParseResult<T> =
  | { ok: true; value: T; repaired: false }
  /** Strict parse failed; JSON5 rescued it. `error` is the strict failure. */
  | { ok: true; value: T; repaired: true; error: string }
  /** `notFound` separates "no such file" from "file exists but is broken" —
   *  callers log those very differently. */
  | { ok: false; error: string; notFound: boolean };

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Parse a config string. Pure — no I/O, no repair. Use this when the caller
 * already holds the file contents, or must not write (e.g. the CLI).
 */
export function parseJsonConfig<T>(raw: string): ParseResult<T> {
  let strictError: string;
  try {
    return { ok: true, value: JSON.parse(raw) as T, repaired: false };
  } catch (err) {
    strictError = msg(err);
  }

  try {
    return {
      ok: true,
      value: JSON5.parse(raw) as T,
      repaired: true,
      error: strictError,
    };
  } catch (err) {
    // Report the JSON5 error, not the strict one. JSON5 got further — it
    // tolerated the slop and failed on whatever is genuinely broken (a
    // truncated write, say), so its position is the actionable one. The
    // strict error would point at the first trailing comma and mislead.
    return { ok: false, error: msg(err), notFound: false };
  }
}

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
