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

  /** Restore workspace from _draft snapshot. Always restores if a draft exists. */
  async restore(): Promise<boolean> {
    log.info('Checking for draft snapshot to restore...');
    try {
      // Use a longer timeout for the fetch — after long idle the git server
      // can be slow (we've seen --unshallow take 36s on the same server).
      const fetched = await this.exec(
        `git fetch --no-tags origin +${DRAFT_BRANCH}:${REMOTE_DRAFT_REF}`,
        { timeout: 90_000 },
      );
      if (fetched === null) {
        // Fetch failed — could be a missing branch, corrupted ref, or just a
        // slow/cold git server. Do NOT delete the remote ref here: a transient
        // timeout would permanently destroy a valid backup.
        log.info('Could not fetch _draft branch from remote, skipping restore');
        return false;
      }

      const draftSha = (
        await this.exec(`git rev-parse ${REMOTE_DRAFT_REF}`)
      )?.trim();
      if (!draftSha) {
        log.warn('Fetched _draft but could not resolve ref');
        return false;
      }

      const draftMsg = (
        await this.exec(`git log -1 --format=%s ${REMOTE_DRAFT_REF}`)
      )?.trim();
      log.info(`Found draft snapshot: ${draftSha.slice(0, 8)} ("${draftMsg}")`);

      // Always restore — the draft is a filesystem backup of the last running
      // container state, including gitignored state files (see the force-add
      // list in doSnapshot) that HEAD never contains.
      log.info('Restoring files from draft snapshot...');
      if (
        (await this.exec(
          `git restore --source=${REMOTE_DRAFT_REF} --worktree -- .`,
        )) === null
      ) {
        log.error('Failed to restore files from draft snapshot');
        return false;
      }

      log.info('Workspace restored from draft snapshot');
      return true;
    } catch (err) {
      log.error(`Restore failed: ${err instanceof Error ? err.message : err}`);
      return false;
    }
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
    if ((await this.exec('git read-tree HEAD', { env })) === null) {
      this.lastError = 'could not read-tree HEAD';
      log.error('Snapshot failed: could not read-tree HEAD');
      return false;
    }

    // Stage all workspace files (respects .gitignore)
    if ((await this.exec('git add -A', { env })) === null) {
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
      '.logs',
    ]) {
      if (fs.existsSync(`${this.workspaceDir}/${f}`)) {
        await this.exec(`git add --force ${f}`, { env });
      }
    }

    // Write tree object from temp index
    const treeSha = (await this.exec('git write-tree', { env }))?.trim();
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
    const parent = (await this.exec(`git rev-parse ${DRAFT_REF}`))?.trim();
    const parentFlag = parent ? `-p ${parent}` : '';
    const msg = `snapshot ${new Date().toISOString()}`;
    const commitSha = (
      await this.exec(`git commit-tree ${treeSha} ${parentFlag} -m "${msg}"`)
    )?.trim();
    if (!commitSha) {
      this.lastError = 'could not create commit';
      log.error('Snapshot failed: could not create commit');
      return false;
    }
    log.debug(`Commit: ${commitSha.slice(0, 8)}`);

    // Point _draft ref at the new commit
    if (
      (await this.exec(`git update-ref ${DRAFT_REF} ${commitSha}`)) === null
    ) {
      this.lastError = 'could not update ref';
      log.error('Snapshot failed: could not update ref');
      return false;
    }

    // Push to remote using + prefix for unconditional force.
    if (
      (await this.exec(`git push origin +${DRAFT_REF}:${DRAFT_REF}`)) === null
    ) {
      // Push failed (e.g., transient 502, slow server). Retry once without
      // deleting the remote ref — a failed push should never destroy the last
      // good snapshot. The + prefix already forces the update.
      log.warn('Push failed, retrying once');
      if (
        (await this.exec(`git push origin +${DRAFT_REF}:${DRAFT_REF}`)) === null
      ) {
        this.lastError = 'push failed after retry';
        log.warn('Snapshot committed locally but push failed after retry');
        return false;
      }
    }

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
   * Run a git command asynchronously. Returns stdout on success, null on failure.
   * Never throws.
   */
  private exec(
    cmd: string,
    opts?: { env?: NodeJS.ProcessEnv; timeout?: number },
  ): Promise<string | null> {
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
            log.warn(`FAILED [exit ${exitCode}]: ${cmd}`);
            if (stderr?.trim()) {
              log.warn(`  stderr: ${stderr.trim()}`);
            }
            resolve(null);
            return;
          }
          resolve(stdout);
        },
      );
    });
  }
}
