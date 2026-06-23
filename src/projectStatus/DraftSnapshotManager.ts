/**
 * Periodic git snapshot manager.
 *
 * Commits all workspace state (files + session state) to a `_draft` branch
 * and force-pushes to the remote. On boot, restores from the draft if one
 * exists. Provides durability against unclean container deaths.
 *
 * Uses git plumbing commands with a temporary index file so snapshots are
 * completely isolated from remy's working tree and any in-progress git ops.
 */

import { exec as execCb } from 'node:child_process';
import fs from 'node:fs';
import { createLogger } from '../logger.js';

const log = createLogger('snapshot');

const TMP_INDEX = '/tmp/.snapshot-index';
const DRAFT_BRANCH = '_draft';
const DRAFT_REF = `refs/heads/${DRAFT_BRANCH}`;
const REMOTE_DRAFT_REF = `refs/remotes/origin/${DRAFT_BRANCH}`;

/**
 * Outcome of a `restore()` call.
 *
 * - `restored`: a draft existed on the remote and the workspace was successfully restored from it.
 * - `no_draft`: the draft branch genuinely doesn't exist on the remote (e.g., fresh app). Safe to proceed in scaffold state.
 * - `unresolvable`: we can't determine whether a draft exists, or we know one exists but couldn't apply it. The caller MUST NOT proceed to scaffold state — doing so risks silently overwriting the user's work.
 */
export type RestoreResult = 'restored' | 'no_draft' | 'unresolvable';

/** Result of running a git command. Captures stderr + exit code on failure
 * so callers can classify error types instead of just "did it work." */
type ExecResult =
  | { ok: true; stdout: string }
  | {
      ok: false;
      stderr: string;
      exitCode: number | undefined;
      timedOut: boolean;
    };

type FetchOutcome = 'no_draft' | 'transient' | 'permanent';

const RESTORE_RETRY_BACKOFFS_MS = [2_000, 6_000, 18_000];

export class DraftSnapshotManager {
  private workspaceDir: string;
  private timer: ReturnType<typeof setInterval> | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private inProgress = false;
  private lastTreeSha: string | null = null;
  private lastAttemptAt: number | null = null;
  private lastSuccessAt: number | null = null;
  private lastDurationMs: number | null = null;
  private lastError: string | null = null;
  private lastRestoreOutcome: RestoreResult | null = null;
  /** Number of consecutive failed pushes (resets on success). Surfaced via
   * `/status` so silent push rot — pushes that fail every interval without
   * anyone noticing — is at least visible to anyone polling. */
  private consecutivePushFailures = 0;

  constructor(workspaceDir: string) {
    this.workspaceDir = workspaceDir;
  }

  /** Start periodic snapshots. */
  start(intervalMs = 60_000): void {
    if (this.timer) {
      return;
    }
    log.info(`Starting periodic snapshots every ${intervalMs / 1000}s`);
    this.timer = setInterval(() => {
      this.snapshot().catch(() => {});
    }, intervalMs);
    this.timer.unref();
  }

  /** Stop periodic and debounced snapshots. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  /** Schedule a snapshot after a delay (debounced). Resets on repeated calls. */
  scheduleSnapshot(delayMs = 5_000): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.snapshot().catch(() => {});
    }, delayMs);
    this.debounceTimer.unref();
  }

  /** Return snapshot health info for the /status endpoint. */
  getSnapshotStatus() {
    return {
      inProgress: this.inProgress,
      lastAttemptAt: this.lastAttemptAt,
      lastSuccessAt: this.lastSuccessAt,
      lastDurationMs: this.lastDurationMs,
      lastError: this.lastError,
      lastRestoreOutcome: this.lastRestoreOutcome,
      consecutivePushFailures: this.consecutivePushFailures,
    };
  }

  /** Take a snapshot: commit workspace to _draft and force-push. */
  async snapshot(): Promise<boolean> {
    if (this.inProgress) {
      log.debug('Snapshot already in progress, skipping');
      return false;
    }
    // Temporary: trace who is calling snapshot
    this.inProgress = true;
    try {
      return await this.doSnapshot();
    } finally {
      this.inProgress = false;
    }
  }

  /**
   * Restore workspace from the `_draft` snapshot.
   *
   * Distinguishes three outcomes (see `RestoreResult`). Transient fetch
   * failures (sideband disconnects, timeouts, 5xx) retry with backoff;
   * permanent failures (auth, repo-not-found) and exhausted retries return
   * `unresolvable` rather than silently falling through to a scaffold
   * state. The caller is responsible for refusing to boot on `unresolvable`.
   */
  async restore(): Promise<RestoreResult> {
    log.info('Checking for draft snapshot to restore...');

    let lastFailureStderr = '';
    let lastFailureTimedOut = false;

    // 1 initial attempt + 3 retries, with backoff between transients.
    const totalAttempts = RESTORE_RETRY_BACKOFFS_MS.length + 1;
    let fetchedOk = false;

    for (let attempt = 1; attempt <= totalAttempts; attempt++) {
      const fetched = await this.exec(
        `git fetch --no-tags origin +${DRAFT_BRANCH}:${REMOTE_DRAFT_REF}`,
        { timeout: 300_000 },
      );

      if (fetched.ok) {
        fetchedOk = true;
        break;
      }

      lastFailureStderr = fetched.stderr;
      lastFailureTimedOut = fetched.timedOut;

      const outcome = this.classifyFetchError(fetched.stderr, fetched.timedOut);
      const stderrExcerpt = excerptStderr(fetched.stderr);

      if (outcome === 'no_draft') {
        log.info(
          `No draft branch on remote (${stderrExcerpt}); proceeding without restore`,
        );
        this.lastError = null;
        this.lastRestoreOutcome = 'no_draft';
        return 'no_draft';
      }

      if (outcome === 'permanent') {
        const reason = `draft fetch permanent failure: ${stderrExcerpt}`;
        log.error(reason);
        this.lastError = reason;
        this.lastRestoreOutcome = 'unresolvable';
        return 'unresolvable';
      }

      // Transient — retry if we have backoffs left
      if (attempt < totalAttempts) {
        const backoffMs = RESTORE_RETRY_BACKOFFS_MS[attempt - 1];
        log.warn(
          `Fetch _draft failed (attempt ${attempt}/${totalAttempts}, transient, retrying in ${backoffMs}ms): ${stderrExcerpt}`,
        );
        await sleep(backoffMs);
      } else {
        log.error(
          `Fetch _draft failed (attempt ${attempt}/${totalAttempts}, transient, no retries left): ${stderrExcerpt}`,
        );
      }
    }

    if (!fetchedOk) {
      const reason = `draft fetch transient failure (retries exhausted): ${excerptStderr(lastFailureStderr) || (lastFailureTimedOut ? 'timed out' : 'unknown')}`;
      this.lastError = reason;
      this.lastRestoreOutcome = 'unresolvable';
      return 'unresolvable';
    }

    // Fetch succeeded — apply the draft. Sub-step failures here are
    // `unresolvable`: we know a draft exists (we just fetched it) but
    // can't apply it, so we MUST NOT fall through to scaffold.
    const revParse = await this.exec(`git rev-parse ${REMOTE_DRAFT_REF}`);
    if (!revParse.ok || !revParse.stdout.trim()) {
      const reason = `fetched _draft but could not resolve ref: ${revParse.ok ? '(empty stdout)' : excerptStderr(revParse.stderr)}`;
      log.error(reason);
      this.lastError = reason;
      this.lastRestoreOutcome = 'unresolvable';
      return 'unresolvable';
    }
    const draftSha = revParse.stdout.trim();

    const logResult = await this.exec(
      `git log -1 --format=%s ${REMOTE_DRAFT_REF}`,
    );
    const draftMsg = logResult.ok ? logResult.stdout.trim() : '';
    log.info(`Found draft snapshot: ${draftSha.slice(0, 8)} ("${draftMsg}")`);

    log.info('Restoring files from draft snapshot...');
    const restored = await this.exec(
      `git restore --source=${REMOTE_DRAFT_REF} --worktree -- .`,
    );
    if (!restored.ok) {
      const reason = `failed to restore files from draft snapshot: ${excerptStderr(restored.stderr)}`;
      log.error(reason);
      this.lastError = reason;
      this.lastRestoreOutcome = 'unresolvable';
      return 'unresolvable';
    }

    log.info('Workspace restored from draft snapshot');
    this.lastError = null;
    this.lastRestoreOutcome = 'restored';
    return 'restored';
  }

  /**
   * Classify a fetch failure by stderr + timeout flag.
   *
   * Conservative defaults: anything not clearly identifiable as
   * "branch missing" or "permanent" is treated as transient. Misclassifying
   * a real "branch missing" as transient costs three retries and a hard
   * fail (loud, recoverable). Misclassifying a transient as `no_draft`
   * silently wipes user state — the bug we're fixing.
   */
  private classifyFetchError(stderr: string, timedOut: boolean): FetchOutcome {
    const s = stderr.toLowerCase();

    // Branch genuinely missing — git's wording across versions:
    if (
      s.includes("couldn't find remote ref") ||
      s.includes('could not find remote ref')
    ) {
      return 'no_draft';
    }

    // Auth / repo-gone — never retry, never fall through to scaffold:
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

    // Common transient network / git-protocol failure modes:
    if (
      s.includes('early eof') ||
      s.includes('fetch-pack') ||
      s.includes('sideband') ||
      s.includes('unexpected disconnect') ||
      s.includes('rpc failed') ||
      s.includes('http 5') ||
      s.includes('connection reset') ||
      s.includes('could not resolve host') ||
      s.includes('operation timed out') ||
      s.includes('ssl_read')
    ) {
      return 'transient';
    }

    // Unknown stderr — treat as transient. See classification rationale above.
    return 'transient';
  }

  private async doSnapshot(): Promise<boolean> {
    const startTime = Date.now();
    this.lastAttemptAt = startTime;
    log.info('Starting snapshot...');

    // Clean any stale temp index and its lock file (git creates
    // TMP_INDEX.lock during operations — if a previous snapshot was
    // killed mid-op, the lock file persists and blocks future runs)
    for (const f of [TMP_INDEX, `${TMP_INDEX}.lock`]) {
      try {
        fs.unlinkSync(f);
      } catch {
        // doesn't exist, fine
      }
    }

    const env = {
      ...process.env,
      GIT_INDEX_FILE: TMP_INDEX,
      // Ensure snapshots never fail due to missing/empty git identity —
      // this is a system operation, not a user commit.
      GIT_AUTHOR_NAME: 'MindStudio Snapshot',
      GIT_AUTHOR_EMAIL: 'noreply@mindstudio.ai',
      GIT_COMMITTER_NAME: 'MindStudio Snapshot',
      GIT_COMMITTER_EMAIL: 'noreply@mindstudio.ai',
    };

    // Seed the temp index from HEAD so git has a valid base
    const readTree = await this.exec('git read-tree HEAD', { env });
    if (!readTree.ok) {
      this.lastError = 'could not read-tree HEAD';
      log.error('Snapshot failed: could not read-tree HEAD');
      return false;
    }

    // Stage all workspace files (respects .gitignore)
    const addAll = await this.exec('git add -A', { env });
    if (!addAll.ok) {
      this.lastError = 'could not stage files';
      log.error('Snapshot failed: could not stage files');
      return false;
    }

    // Force-add ignored state files (only if they exist). These are all in
    // .gitignore so the agent's regular commits don't pollute main branch
    // history, but the draft branch needs them for full restore fidelity.
    for (const f of [
      '.sandbox-state.json',
      '.remy-session.json',
      '.project-status.json',
      '.remy-stats.json',
      '.remy-design-sample.json',
      '.remy-plan.md',
      '.remy-brand.json',
      '.remy-brand.cache.json',
      '.logs',
    ]) {
      if (fs.existsSync(`${this.workspaceDir}/${f}`)) {
        await this.exec(`git add --force ${f}`, { env });
      }
    }

    // Write tree object from temp index
    const writeTree = await this.exec('git write-tree', { env });
    const treeSha = writeTree.ok ? writeTree.stdout.trim() : '';
    if (!treeSha) {
      this.lastError = 'could not write tree';
      log.error('Snapshot failed: could not write tree');
      return false;
    }
    log.debug(`Tree: ${treeSha.slice(0, 8)}`);

    // Skip if tree is identical to the last snapshot (nothing changed)
    if (this.lastTreeSha && treeSha === this.lastTreeSha) {
      log.info(`No changes since last snapshot, skipping`);
      try {
        fs.unlinkSync(TMP_INDEX);
      } catch {
        // fine
      }
      return true;
    }

    // Create commit object. Use the current _draft as parent (if it exists)
    // so git can delta-compress the push — only changed objects are transferred.
    // The old commit becomes unreachable after update-ref, so history stays shallow.
    const parentResult = await this.exec(`git rev-parse ${DRAFT_REF}`);
    const parent = parentResult.ok ? parentResult.stdout.trim() : '';
    const parentFlag = parent ? `-p ${parent}` : '';
    const msg = `snapshot ${new Date().toISOString()}`;
    const commitResult = await this.exec(
      `git commit-tree ${treeSha} ${parentFlag} -m "${msg}"`,
    );
    const commitSha = commitResult.ok ? commitResult.stdout.trim() : '';
    if (!commitSha) {
      this.lastError = 'could not create commit';
      log.error('Snapshot failed: could not create commit');
      return false;
    }
    log.debug(`Commit: ${commitSha.slice(0, 8)}`);

    // Point _draft ref at the new commit
    const updateRef = await this.exec(
      `git update-ref ${DRAFT_REF} ${commitSha}`,
    );
    if (!updateRef.ok) {
      this.lastError = 'could not update ref';
      log.error('Snapshot failed: could not update ref');
      return false;
    }

    // Push to remote using + prefix for unconditional force.
    let pushed = await this.exec(`git push origin +${DRAFT_REF}:${DRAFT_REF}`);
    if (!pushed.ok) {
      // Push failed (e.g., transient 502, slow server). Retry once without
      // deleting the remote ref — a failed push should never destroy the last
      // good snapshot. The + prefix already forces the update.
      log.warn('Push failed, retrying once');
      pushed = await this.exec(`git push origin +${DRAFT_REF}:${DRAFT_REF}`);
      if (!pushed.ok) {
        this.consecutivePushFailures++;
        this.lastError = 'push failed after retry';
        log.warn(
          `Snapshot committed locally but push failed after retry (consecutivePushFailures=${this.consecutivePushFailures})`,
        );
        return false;
      }
    }

    this.consecutivePushFailures = 0;
    this.lastTreeSha = treeSha;

    // Clean up temp index
    try {
      fs.unlinkSync(TMP_INDEX);
    } catch {
      // fine
    }

    const elapsed = Date.now() - startTime;
    this.lastSuccessAt = Date.now();
    this.lastDurationMs = elapsed;
    this.lastError = null;
    log.info(`Snapshot completed in ${elapsed}ms (${commitSha.slice(0, 8)})`);
    return true;
  }

  /**
   * Run a git command asynchronously. Returns structured result so callers
   * can distinguish "command failed because X" from a generic null. Never
   * throws.
   */
  private exec(
    cmd: string,
    opts?: { env?: NodeJS.ProcessEnv; timeout?: number },
  ): Promise<ExecResult> {
    return new Promise((resolve) => {
      execCb(
        cmd,
        {
          cwd: this.workspaceDir,
          encoding: 'utf-8',
          timeout: opts?.timeout ?? 30_000,
          ...(opts?.env ? { env: opts.env } : {}),
        },
        (err, stdout, stderr) => {
          if (err) {
            const exitCode = (err as { code?: number }).code;
            // Node sets `killed: true` and `signal: 'SIGTERM'` when child_process
            // hits the `timeout` option.
            const e = err as {
              killed?: boolean;
              signal?: NodeJS.Signals | null;
            };
            const timedOut = e.killed === true && e.signal === 'SIGTERM';
            log.warn(`FAILED [exit ${exitCode}]: ${cmd}`);
            if (stderr?.trim()) {
              log.warn(`  stderr: ${stderr.trim()}`);
            }
            resolve({
              ok: false,
              stderr: stderr ?? '',
              exitCode,
              timedOut,
            });
            return;
          }
          resolve({ ok: true, stdout });
        },
      );
    });
  }
}

/** Collapse multi-line stderr to a single line for log readability. */
function excerptStderr(stderr: string): string {
  return stderr
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .join(' | ')
    .slice(0, 300);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref();
  });
}
