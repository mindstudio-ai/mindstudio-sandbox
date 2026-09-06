/**
 * Legacy restore from the `_draft` branch.
 *
 * Editor state used to be persisted by force-pushing the working tree to a
 * `_draft` branch on the app's repo; it now lives in a home-directory snapshot
 * (HomeSnapshotManager). An app whose editor has not been opened since that
 * change has no snapshot yet and its last state is still on `_draft`, so the
 * first boot after the change restores from here and then seeds the snapshot
 * store. Nothing writes `_draft` any more; once the app has a snapshot the git
 * server drops the ref on its next push.
 */

import { exec as execCb } from 'node:child_process';
import { createLogger } from '../logger.js';

const log = createLogger('legacy-draft');

const DRAFT_BRANCH = '_draft';
const REMOTE_DRAFT_REF = `refs/remotes/origin/${DRAFT_BRANCH}`;
const RESTORE_RETRY_BACKOFFS_MS = [2_000, 6_000, 18_000];

/**
 * - `restored`: a draft existed on the remote and the workspace was rebuilt from it.
 * - `no_draft`: the branch does not exist. Safe to proceed in scaffold state.
 * - `unresolvable`: could not tell, or could not apply a draft that exists. The
 *   caller MUST NOT proceed to scaffold state.
 */
export type LegacyRestoreResult = 'restored' | 'no_draft' | 'unresolvable';

type FetchOutcome = 'no_draft' | 'transient' | 'permanent';

type ExecResult =
  | { ok: true; stdout: string }
  | { ok: false; stderr: string; timedOut: boolean };

export async function restoreFromLegacyDraft(
  workspaceDir: string,
): Promise<{ outcome: LegacyRestoreResult; error: string | null }> {
  log.info('No workspace snapshot; checking for a legacy _draft branch...');

  let lastFailureStderr = '';
  let lastFailureTimedOut = false;
  const totalAttempts = RESTORE_RETRY_BACKOFFS_MS.length + 1;
  let fetchedOk = false;

  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    // Only the tip is ever read, so depth 1 keeps the fetch fast however deep
    // the branch's history grew.
    const fetched = await exec(
      workspaceDir,
      `git fetch --no-tags --depth=1 origin +${DRAFT_BRANCH}:${REMOTE_DRAFT_REF}`,
      300_000,
    );
    if (fetched.ok) {
      fetchedOk = true;
      break;
    }

    lastFailureStderr = fetched.stderr;
    lastFailureTimedOut = fetched.timedOut;
    const outcome = classifyFetchError(fetched.stderr, fetched.timedOut);
    const excerpt = excerptStderr(fetched.stderr);

    if (outcome === 'no_draft') {
      log.info(`No _draft branch on remote (${excerpt})`);
      return { outcome: 'no_draft', error: null };
    }
    if (outcome === 'permanent') {
      const error = `draft fetch permanent failure: ${excerpt}`;
      log.error(error);
      return { outcome: 'unresolvable', error };
    }
    if (attempt < totalAttempts) {
      const backoffMs = RESTORE_RETRY_BACKOFFS_MS[attempt - 1];
      log.warn(
        `Fetch _draft failed (attempt ${attempt}/${totalAttempts}, transient, retrying in ${backoffMs}ms): ${excerpt}`,
      );
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }

  if (!fetchedOk) {
    const error = `draft fetch transient failure (retries exhausted): ${excerptStderr(lastFailureStderr) || (lastFailureTimedOut ? 'timed out' : 'unknown')}`;
    log.error(error);
    return { outcome: 'unresolvable', error };
  }

  // Fetched — apply it. Failures here are `unresolvable`: a draft exists and
  // could not be applied, so scaffold state would overwrite the user's work.
  const revParse = await exec(
    workspaceDir,
    `git rev-parse ${REMOTE_DRAFT_REF}`,
  );
  if (!revParse.ok || !revParse.stdout.trim()) {
    const error = `fetched _draft but could not resolve ref: ${revParse.ok ? '(empty stdout)' : excerptStderr(revParse.stderr)}`;
    log.error(error);
    return { outcome: 'unresolvable', error };
  }
  log.info(`Found legacy draft ${revParse.stdout.trim().slice(0, 8)}`);

  const restored = await exec(
    workspaceDir,
    `git restore --source=${REMOTE_DRAFT_REF} --worktree -- .`,
  );
  if (!restored.ok) {
    const error = `failed to restore files from _draft: ${excerptStderr(restored.stderr)}`;
    log.error(error);
    return { outcome: 'unresolvable', error };
  }

  log.info('Workspace restored from legacy _draft');
  return { outcome: 'restored', error: null };
}

/**
 * Conservative: anything not clearly "branch missing" or "permanent" is
 * transient. Misclassifying a missing branch as transient costs three retries
 * and a loud fail; misclassifying a transient as `no_draft` silently wipes
 * user state.
 */
function classifyFetchError(stderr: string, timedOut: boolean): FetchOutcome {
  const s = stderr.toLowerCase();
  if (
    s.includes("couldn't find remote ref") ||
    s.includes('could not find remote ref')
  ) {
    return 'no_draft';
  }
  if (
    s.includes('repository not found') ||
    s.includes('authentication failed') ||
    s.includes('permission denied') ||
    s.includes('access denied') ||
    s.includes('invalid username or password')
  ) {
    return 'permanent';
  }
  if (timedOut) {
    return 'transient';
  }
  return 'transient';
}

function excerptStderr(stderr: string): string {
  return stderr
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .join(' | ')
    .slice(0, 300);
}

function exec(cwd: string, cmd: string, timeout = 30_000): Promise<ExecResult> {
  return new Promise((resolve) => {
    execCb(cmd, { cwd, encoding: 'utf-8', timeout }, (err, stdout, stderr) => {
      if (err) {
        const e = err as { killed?: boolean; signal?: NodeJS.Signals | null };
        log.warn(`FAILED: ${cmd}`);
        if (stderr?.trim()) {
          log.warn(`  stderr: ${stderr.trim()}`);
        }
        resolve({
          ok: false,
          stderr: stderr ?? '',
          timedOut: e.killed === true && e.signal === 'SIGTERM',
        });
        return;
      }
      resolve({ ok: true, stdout });
    });
  });
}
