/**
 * Periodic git snapshot manager.
 *
 * Commits all workspace state (files + session state) to a `_draft` branch
 * and force-pushes to the remote. On boot, restores from the draft if it's
 * newer than HEAD. Provides durability against unclean container deaths.
 *
 * Uses git plumbing commands with a temporary index file so snapshots are
 * completely isolated from remy's working tree and any in-progress git ops.
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import { createLogger } from './logger.js';

const log = createLogger('snapshot');

const TMP_INDEX = '/tmp/.snapshot-index';
const DRAFT_BRANCH = '_draft';

export class SnapshotManager {
  private workspaceDir: string;
  private timer: ReturnType<typeof setInterval> | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private inProgress = false;

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

  /** Take a snapshot: commit workspace to _draft and force-push. */
  async snapshot(): Promise<boolean> {
    if (this.inProgress) {
      return false;
    }
    this.inProgress = true;
    try {
      return this.doSnapshot();
    } finally {
      this.inProgress = false;
    }
  }

  /** Restore workspace from _draft branch if it's newer than HEAD. */
  async restore(): Promise<boolean> {
    try {
      // Fetch the draft branch (may not exist)
      const fetched = this.exec('git fetch origin _draft');
      if (fetched === null) {
        log.info('No draft branch on remote, skipping restore');
        return false;
      }

      // Verify it exists locally after fetch
      if (this.exec('git rev-parse --verify origin/_draft') === null) {
        return false;
      }

      // Compare timestamps
      const draftTsStr = this.exec('git log -1 --format=%ct origin/_draft');
      const headTsStr = this.exec('git log -1 --format=%ct HEAD');
      if (draftTsStr === null || headTsStr === null) {
        return false;
      }

      const draftTs = parseInt(draftTsStr.trim(), 10);
      const headTs = parseInt(headTsStr.trim(), 10);

      if (isNaN(draftTs) || isNaN(headTs) || draftTs <= headTs) {
        log.info(
          `Draft not newer than HEAD (draft=${draftTs}, head=${headTs}), skipping restore`,
        );
        return false;
      }

      // Overlay draft files onto working tree without touching the index
      if (
        this.exec('git restore --source=origin/_draft --worktree -- .') === null
      ) {
        log.error('Failed to restore files from draft branch');
        return false;
      }

      log.info(
        `Restored workspace from draft snapshot (draft=${draftTs}, head=${headTs})`,
      );
      return true;
    } catch (err) {
      log.error(`Restore failed: ${err instanceof Error ? err.message : err}`);
      return false;
    }
  }

  private doSnapshot(): boolean {
    const startTime = Date.now();

    // Clean any stale temp index
    try {
      fs.unlinkSync(TMP_INDEX);
    } catch {
      // doesn't exist, fine
    }

    const env = { ...process.env, GIT_INDEX_FILE: TMP_INDEX };

    // Stage all files (respects .gitignore)
    if (this.exec('git add -A', { env }) === null) {
      return false;
    }

    // Force-add ignored state files
    this.exec('git add --force .sandbox-state.json', { env });
    this.exec('git add --force .remy-session.json', { env });

    // Write tree object from temp index
    const treeSha = this.exec('git write-tree', { env })?.trim();
    if (!treeSha) {
      return false;
    }

    // Create commit object
    const msg = `snapshot ${new Date().toISOString()}`;
    const commitSha = this.exec(
      `git commit-tree ${treeSha} -m "${msg}"`,
    )?.trim();
    if (!commitSha) {
      return false;
    }

    // Point _draft ref at the new commit
    if (
      this.exec(`git update-ref refs/heads/${DRAFT_BRANCH} ${commitSha}`) ===
      null
    ) {
      return false;
    }

    // Force-push to remote
    if (this.exec(`git push --force origin ${DRAFT_BRANCH}`) === null) {
      // Push failed but local objects are written — next tick will retry
      log.warn('Snapshot committed locally but push failed');
      return false;
    }

    // Clean up temp index
    try {
      fs.unlinkSync(TMP_INDEX);
    } catch {
      // fine
    }

    const elapsed = Date.now() - startTime;
    log.info(`Snapshot completed in ${elapsed}ms (${commitSha.slice(0, 8)})`);
    return true;
  }

  /**
   * Run a git command synchronously. Returns stdout on success, null on failure.
   * Never throws.
   */
  private exec(cmd: string, opts?: { env?: NodeJS.ProcessEnv }): string | null {
    try {
      return execSync(cmd, {
        cwd: this.workspaceDir,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30_000,
        ...(opts?.env ? { env: opts.env } : {}),
      }) as string;
    } catch (err: unknown) {
      const execErr = err as { stderr?: string; message?: string };
      log.debug(
        `git command failed: ${cmd} — ${execErr.stderr?.trim() || execErr.message}`,
      );
      return null;
    }
  }
}
