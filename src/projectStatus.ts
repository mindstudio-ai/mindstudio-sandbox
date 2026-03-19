/**
 * Project status tracking.
 *
 * Manages two concerns:
 * 1. Spec/code sync status — dirty flags for user edits
 * 2. Onboarding state — which phase of the guided onboarding flow
 *
 * Also maintains a `refs/sync-point` git ref for diffing user changes.
 * Persisted to `.project-status.json` so it survives snapshots.
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from './logger.js';

const log = createLogger('project-status');

const SYNC_REF = 'refs/sync-point';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProjectOnboardingState =
  | 'intake'
  | 'initialSpecAuthoring'
  | 'initialCodegen'
  | 'onboardingFinished';

const ONBOARDING_ORDER: ProjectOnboardingState[] = [
  'intake',
  'initialSpecAuthoring',
  'initialCodegen',
  'onboardingFinished',
];

export interface ProjectStatus {
  specDirty: boolean;
  codeDirty: boolean;
  onboardingState: ProjectOnboardingState;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let status: ProjectStatus = {
  specDirty: false,
  codeDirty: false,
  onboardingState: 'intake',
};
let statusFilePath: string;
let workDir: string;

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

export function initProjectStatus(workspaceDir: string): void {
  workDir = workspaceDir;
  statusFilePath = path.join(workspaceDir, '.project-status.json');

  // Try reading the new file first
  if (tryReadStatus(statusFilePath)) {
    // success
  } else {
    // Fall back to old .sync-status.json for migration
    const oldPath = path.join(workspaceDir, '.sync-status.json');
    if (tryReadStatus(oldPath)) {
      log.info('Migrated from .sync-status.json → .project-status.json');
      flush();
      try {
        fs.unlinkSync(oldPath);
      } catch {
        // ignore
      }
    } else {
      status = {
        specDirty: false,
        codeDirty: false,
        onboardingState: 'intake',
      };
    }
  }

  if (status.specDirty || status.codeDirty) {
    log.info(
      `Restored: specDirty=${status.specDirty}, codeDirty=${status.codeDirty}`,
    );
  }
  if (status.onboardingState !== 'intake') {
    log.info(`Restored: onboardingState=${status.onboardingState}`);
  }

  // Ensure sync-point ref exists (set to HEAD if missing)
  if (!hasSyncRef()) {
    updateSyncRef();
  }
}

function tryReadStatus(filePath: string): boolean {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    status = {
      specDirty: parsed.specDirty === true,
      codeDirty: parsed.codeDirty === true,
      onboardingState: ONBOARDING_ORDER.includes(parsed.onboardingState)
        ? parsed.onboardingState
        : 'intake',
    };
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Getters
// ---------------------------------------------------------------------------

export function getProjectStatus(): ProjectStatus {
  return { ...status };
}

export function getSyncStatus(): { specDirty: boolean; codeDirty: boolean } {
  return { specDirty: status.specDirty, codeDirty: status.codeDirty };
}

export function getOnboardingState(): ProjectOnboardingState {
  return status.onboardingState;
}

// ---------------------------------------------------------------------------
// Sync status mutations
// ---------------------------------------------------------------------------

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
  status.specDirty = false;
  status.codeDirty = false;
  log.info('Sync status cleared');
  flush();
  updateSyncRef();
  return true;
}

// ---------------------------------------------------------------------------
// Onboarding state mutations
// ---------------------------------------------------------------------------

/**
 * Set the onboarding state. Forward-only gate by default.
 * Pass force=true to allow setting any state (for user override / testing).
 */
export function setOnboardingState(
  state: ProjectOnboardingState,
  force?: boolean,
): boolean {
  const currentIdx = ONBOARDING_ORDER.indexOf(status.onboardingState);
  const newIdx = ONBOARDING_ORDER.indexOf(state);
  if (newIdx < 0) {
    return false;
  }
  if (!force && newIdx <= currentIdx) {
    return false;
  }
  if (state === status.onboardingState) {
    return false;
  }
  log.info(`Onboarding: ${status.onboardingState} → ${state}`);
  status.onboardingState = state;
  flush();
  return true;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function flush(): void {
  fs.writeFileSync(statusFilePath, JSON.stringify(status), 'utf-8');
}

// ---------------------------------------------------------------------------
// Git sync ref
// ---------------------------------------------------------------------------

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
