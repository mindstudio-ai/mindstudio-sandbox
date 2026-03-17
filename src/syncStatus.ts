/**
 * Spec/code sync status tracking.
 *
 * Tracks whether user edits have made spec (src/) or code (dist/)
 * stale relative to each other. Persisted to disk so the flags
 * survive hibernation via git snapshots.
 *
 * Also maintains a `refs/sync-point` git ref that marks the last
 * known-good sync state. Remy can diff against this ref to see
 * exactly what the user changed since the last sync.
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from './logger.js';

const log = createLogger('sync-status');

const SYNC_REF = 'refs/sync-point';

export interface SyncStatus {
  specDirty: boolean;
  codeDirty: boolean;
}

let status: SyncStatus = { specDirty: false, codeDirty: false };
let statusFilePath: string;
let workDir: string;

export function initSyncStatus(workspaceDir: string): void {
  workDir = workspaceDir;
  statusFilePath = path.join(workspaceDir, '.sync-status.json');
  try {
    const raw = fs.readFileSync(statusFilePath, 'utf-8');
    const parsed = JSON.parse(raw);
    status = {
      specDirty: parsed.specDirty === true,
      codeDirty: parsed.codeDirty === true,
    };
    if (status.specDirty || status.codeDirty) {
      log.info(
        `Restored: specDirty=${status.specDirty}, codeDirty=${status.codeDirty}`,
      );
    }
  } catch {
    status = { specDirty: false, codeDirty: false };
  }

  // Ensure sync-point ref exists (set to HEAD if missing)
  if (!hasSyncRef()) {
    updateSyncRef();
  }
}

export function getSyncStatus(): SyncStatus {
  return { ...status };
}

export function markSpecDirty(): boolean {
  if (status.specDirty) {
    return false;
  }
  status.specDirty = true;
  log.info('Spec marked dirty');
  flush();
  return true;
}

export function markCodeDirty(): boolean {
  if (status.codeDirty) {
    return false;
  }
  status.codeDirty = true;
  log.info('Code marked dirty');
  flush();
  return true;
}

export function clearSyncStatus(): boolean {
  if (!status.specDirty && !status.codeDirty) {
    return false;
  }
  status = { specDirty: false, codeDirty: false };
  log.info('Sync status cleared');
  flush();
  updateSyncRef();
  return true;
}

function flush(): void {
  fs.writeFileSync(statusFilePath, JSON.stringify(status), 'utf-8');
}

function hasSyncRef(): boolean {
  try {
    execSync(`git rev-parse --verify ${SYNC_REF}`, {
      cwd: workDir,
      stdio: 'pipe',
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Update the sync-point ref to the current working tree state.
 *
 * Creates a tree object from the current working directory (including
 * unstaged changes) and commits it to refs/sync-point. This avoids
 * touching the real index or creating branches.
 */
function updateSyncRef(): void {
  try {
    // Use a temporary index to capture working tree state
    const tmpIndex = path.join(workDir, '.git', 'sync-point-index');
    const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };

    execSync('git add -A', { cwd: workDir, stdio: 'pipe', env });
    const treeSha = execSync('git write-tree', {
      cwd: workDir,
      stdio: 'pipe',
      env,
    })
      .toString()
      .trim();

    // Clean up temp index
    try {
      fs.unlinkSync(tmpIndex);
    } catch {
      // ignore
    }

    const commitSha = execSync(`git commit-tree ${treeSha} -m "sync-point"`, {
      cwd: workDir,
      stdio: 'pipe',
    })
      .toString()
      .trim();

    execSync(`git update-ref ${SYNC_REF} ${commitSha}`, {
      cwd: workDir,
      stdio: 'pipe',
    });

    log.info(`Sync ref updated: ${commitSha.slice(0, 8)}`);
  } catch (err) {
    log.warn(
      `Failed to update sync ref: ${err instanceof Error ? err.message : err}`,
    );
  }
}
