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

import { exec as execCb } from 'node:child_process';
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
      return await this.doSnapshot();
    } finally {
      this.inProgress = false;
    }
  }

  /** Restore workspace from _draft snapshot. Always restores if a draft exists. */
  async restore(): Promise<boolean> {
    log.info('Checking for draft snapshot to restore...');
    try {
      // Delete any stale local tracking ref before fetching. Snapshot commits
      // are parentless orphans, so old ones get GC'd on the remote — if the
      // local ref still points at a GC'd object, fetch negotiation fails with
      // "upload-pack: not our ref".
      await this.exec(`git update-ref -d ${REMOTE_DRAFT_REF}`);

      // Fetch the draft branch into a proper remote tracking ref
      const fetched = await this.exec(
        `git fetch origin ${DRAFT_BRANCH}:${REMOTE_DRAFT_REF}`,
      );
      if (fetched === null) {
        log.info('No _draft branch on remote, skipping restore');
        return false;
      }

      // Verify the ref exists
      const draftSha = (
        await this.exec(`git rev-parse --verify ${REMOTE_DRAFT_REF}`)
      )?.trim();
      if (!draftSha) {
        log.warn('Fetched _draft but ref does not exist locally');
        return false;
      }

      const draftMsg = (
        await this.exec(`git log -1 --format=%s ${REMOTE_DRAFT_REF}`)
      )?.trim();
      log.info(`Found draft snapshot: ${draftSha.slice(0, 8)} ("${draftMsg}")`);

      // Always restore — the draft is a filesystem backup of the last running
      // container state, including gitignored state files (.sandbox-state.json,
      // .remy-session.json, .project-status.json) that HEAD never contains.
      log.info('Restoring files from draft snapshot...');
      if (
        (await this.exec(
          `git restore --source=${REMOTE_DRAFT_REF} --worktree -- .`,
        )) === null
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

  private async doSnapshot(): Promise<boolean> {
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
    if ((await this.exec('git read-tree HEAD', { env })) === null) {
      log.error('Snapshot failed: could not read-tree HEAD');
      return false;
    }

    // Stage all workspace files (respects .gitignore)
    if ((await this.exec('git add -A', { env })) === null) {
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
        await this.exec(`git add --force ${f}`, { env });
      }
    }

    // Write tree object from temp index
    const treeSha = (await this.exec('git write-tree', { env }))?.trim();
    if (!treeSha) {
      log.error('Snapshot failed: could not write tree');
      return false;
    }
    log.debug(`Tree: ${treeSha.slice(0, 8)}`);

    // Skip if tree is identical to the current _draft (nothing changed)
    const previousTree = (
      await this.exec(`git rev-parse ${DRAFT_REF}^{tree}`)
    )?.trim();
    if (previousTree && treeSha === previousTree) {
      log.info(`No changes since last snapshot, skipping`);
      try {
        fs.unlinkSync(TMP_INDEX);
      } catch {
        // fine
      }
      return true;
    }

    // Create commit object
    const msg = `snapshot ${new Date().toISOString()}`;
    const commitSha = (
      await this.exec(`git commit-tree ${treeSha} -m "${msg}"`)
    )?.trim();
    if (!commitSha) {
      log.error('Snapshot failed: could not create commit');
      return false;
    }
    log.debug(`Commit: ${commitSha.slice(0, 8)}`);

    // Point _draft ref at the new commit
    if (
      (await this.exec(`git update-ref ${DRAFT_REF} ${commitSha}`)) === null
    ) {
      log.error('Snapshot failed: could not update ref');
      return false;
    }

    // Delete stale remote tracking ref so push negotiation doesn't send an
    // outdated expected-old-value (causes "incorrect old value provided").
    await this.exec(`git update-ref -d ${REMOTE_DRAFT_REF}`);

    // Push to remote using + prefix for unconditional force.
    if (
      (await this.exec(`git push origin +${DRAFT_REF}:${DRAFT_REF}`)) === null
    ) {
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
   * Run a git command asynchronously. Returns stdout on success, null on failure.
   * Never throws.
   */
  private exec(
    cmd: string,
    opts?: { env?: NodeJS.ProcessEnv },
  ): Promise<string | null> {
    return new Promise((resolve) => {
      execCb(
        cmd,
        {
          cwd: this.workspaceDir,
          encoding: 'utf-8',
          timeout: 30_000,
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
