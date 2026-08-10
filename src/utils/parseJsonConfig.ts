/**
 * Pure parser for MindStudio-owned JSON config files. No I/O, no repair.
 *
 * App configs (`mindstudio.json`, interface configs like `web.json`) are
 * authored by remy, so they pick up the usual LLM-JSON slop — most often a
 * trailing comma left behind when an array entry is deleted.
 *
 * Strategy: strict JSON.parse first, JSON5 as a rescue. Strict-first means the
 * steady state is unaffected; the JSON5 path only engages for a file that would
 * otherwise have failed outright.
 *
 * Kept in its own leaf module, importing nothing but JSON5, because the
 * `mindstudio-prod` CLI needs exactly this function and nothing else. Its
 * sibling `jsonConfig.ts` adds read-and-repair-on-disk on top, which drags in
 * the file lock, the logger, and the file watcher — a graph a short-lived CLI
 * has no business loading to parse one string. See `jsonConfig.ts` for why
 * repairing on disk matters for the callers that DO write.
 */

import JSON5 from 'json5';

export type ParseResult<T> =
  | { ok: true; value: T; repaired: false }
  /** Strict parse failed; JSON5 rescued it. `error` is the strict failure. */
  | { ok: true; value: T; repaired: true; error: string }
  /** `notFound` separates "no such file" from "file exists but is broken" —
   *  callers log those very differently. */
  | { ok: false; error: string; notFound: boolean };

export function msg(err: unknown): string {
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
