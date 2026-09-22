/**
 * Forked-app detection.
 *
 * A v2-app fork is a main-only git copy of its source, so it never carries the
 * source's workspace snapshot — where `.project-status.json` lives. The backend
 * can't reliably seed that file into the editor, so instead it leaves a durable
 * git marker: an `--allow-empty` stamp commit on `main` carrying the trailer
 *
 *   Mindstudio-Fork-Source: <sourceAppId>
 *
 * The sandbox reads that trailer on boot to decide whether a fresh app is a fork
 * (and should open in finished mode rather than onboarding). The commit is
 * permanent in history — gating on project-status, not the marker, keeps the
 * resulting action one-time (see the boot hook in index.ts).
 */

import { execFile } from 'node:child_process';
import { createLogger } from '../logger.ts';

const log = createLogger('fork-detect');

const FORK_TRAILER_KEY = 'Mindstudio-Fork-Source';

/**
 * Read the fork stamp trailer from `main`'s tip. Returns the source appId if
 * present, else `null`.
 *
 * Best-effort: any git failure (missing ref, git error, timeout) resolves to
 * `null` — this runs on the boot path and must never throw or block.
 *
 * Queries `origin/main` with `-1`: `origin/main` is the pushed fork tip and is
 * present even in our `--depth 1` clone, and `-1` reads only that tip commit —
 * which is all a shallow clone guarantees, and on a fork's first boot the stamp
 * commit *is* the tip. Uses `execFile` (no shell) so the `%(trailers:…)` format
 * string needs no quoting.
 */
export function readForkSource(workspaceDir: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'git',
      [
        'log',
        '-1',
        'origin/main',
        `--format=%(trailers:key=${FORK_TRAILER_KEY},valueonly)`,
      ],
      { cwd: workspaceDir, encoding: 'utf-8', timeout: 10_000 },
      (err, stdout) => {
        if (err) {
          log.info(`Fork trailer check skipped: ${(err as Error).message}`);
          resolve(null);
          return;
        }
        const value = stdout.trim();
        resolve(value.length > 0 ? value : null);
      },
    );
  });
}
