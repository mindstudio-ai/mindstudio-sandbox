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
const DRAFT_REF = `refs/heads/${DRAFT_BRANCH}`;
const REMOTE_DRAFT_REF = `refs/remotes/origin/${DRAFT_BRANCH}`;

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
      log.debug('Snapshot already in progress, skipping');
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
    log.info('Checking for draft snapshot to restore...');
    try {
      // Fetch the draft branch into a proper remote tracking ref
      const fetched = this.exec(
        `git fetch origin ${DRAFT_BRANCH}:${REMOTE_DRAFT_REF}`,
      );
      if (fetched === null) {
        log.info('No _draft branch on remote, skipping restore');
        return false;
      }

      // Verify the ref exists
      const draftSha = this.exec(
        `git rev-parse --verify ${REMOTE_DRAFT_REF}`,
      )?.trim();
      if (!draftSha) {
        log.warn('Fetched _draft but ref does not exist locally');
        return false;
      }
      log.info(`Found draft snapshot: ${draftSha.slice(0, 8)}`);

      // Compare timestamps
      const draftTsStr = this.exec(
        `git log -1 --format=%ct ${REMOTE_DRAFT_REF}`,
      );
      const headTsStr = this.exec('git log -1 --format=%ct HEAD');
      if (draftTsStr === null || headTsStr === null) {
        log.warn('Could not read commit timestamps');
        return false;
      }

      const draftTs = parseInt(draftTsStr.trim(), 10);
      const headTs = parseInt(headTsStr.trim(), 10);
      log.info(
        `Timestamps — draft: ${draftTs} (${new Date(draftTs * 1000).toISOString()}), HEAD: ${headTs} (${new Date(headTs * 1000).toISOString()})`,
      );

      if (isNaN(draftTs) || isNaN(headTs) || draftTs <= headTs) {
        log.info('Draft is not newer than HEAD, skipping restore');
        return false;
      }

      // Show what the draft contains
      const draftMsg = this.exec(
        `git log -1 --format=%s ${REMOTE_DRAFT_REF}`,
      )?.trim();
      log.info(`Draft commit message: "${draftMsg}"`);

      // Overlay draft files onto working tree without touching the index
      log.info('Restoring files from draft snapshot...');
      if (
        this.exec(
          `git restore --source=${REMOTE_DRAFT_REF} --worktree -- .`,
        ) === null
      ) {
        log.error('Failed to restore files from draft branch');
        return false;
      }

      log.info('Workspace restored from draft snapshot');
      return true;
    } catch (err) {
      log.error(`Restore failed: ${err instanceof Error ? err.message : err}`);
      return false;
    }
  }

  private doSnapshot(): boolean {
    const startTime = Date.now();
    log.info('Starting snapshot...');

    // Clean any stale temp index
    try {
      fs.unlinkSync(TMP_INDEX);
    } catch {
      // doesn't exist, fine
    }

    const env = { ...process.env, GIT_INDEX_FILE: TMP_INDEX };

    // Seed the temp index from HEAD so git has a valid base
    if (this.exec('git read-tree HEAD', { env }) === null) {
      log.error('Snapshot failed: could not read-tree HEAD');
      return false;
    }

    // Stage all workspace files (respects .gitignore)
    if (this.exec('git add -A', { env }) === null) {
      log.error('Snapshot failed: could not stage files');
      return false;
    }

    // Force-add ignored state files (only if they exist)
    for (const f of [
      '.sandbox-state.json',
      '.remy-session.json',
      '.project-status.json',
    ]) {
      if (fs.existsSync(`${this.workspaceDir}/${f}`)) {
        this.exec(`git add --force ${f}`, { env });
      }
    }

    // Write tree object from temp index
    const treeSha = this.exec('git write-tree', { env })?.trim();
    if (!treeSha) {
      log.error('Snapshot failed: could not write tree');
      return false;
    }
    log.debug(`Tree: ${treeSha.slice(0, 8)}`);

    // Create commit object
    const msg = `snapshot ${new Date().toISOString()}`;
    const commitSha = this.exec(
      `git commit-tree ${treeSha} -m "${msg}"`,
    )?.trim();
    if (!commitSha) {
      log.error('Snapshot failed: could not create commit');
      return false;
    }
    log.debug(`Commit: ${commitSha.slice(0, 8)}`);

    // Point _draft ref at the new commit
    if (this.exec(`git update-ref ${DRAFT_REF} ${commitSha}`) === null) {
      log.error('Snapshot failed: could not update ref');
      return false;
    }

    // Push to remote using + prefix for unconditional force (bypasses
    // server-side compare-and-swap checks that --force can still trigger).
    if (this.exec(`git push origin +${DRAFT_REF}:${DRAFT_REF}`) === null) {
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
      const result = execSync(cmd, {
        cwd: this.workspaceDir,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30_000,
        ...(opts?.env ? { env: opts.env } : {}),
      }) as string;
      return result;
    } catch (err: unknown) {
      const execErr = err as {
        stderr?: string;
        stdout?: string;
        status?: number;
        message?: string;
      };
      const stderr = execErr.stderr?.trim();
      const exitCode = execErr.status;
      log.warn(`FAILED [exit ${exitCode}]: ${cmd}`);
      if (stderr) {
        log.warn(`  stderr: ${stderr}`);
      }
      return null;
    }
  }
}
