/**
 * Project status tracking.
 *
 * Manages onboarding state — which phase of the guided onboarding flow
 * the project is in. Persisted to `.project-status.json` so it survives
 * snapshots.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '../logger.js';

const log = createLogger('project');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProjectOnboardingState =
  | 'intake'
  | 'initialSpecReview'
  | 'initialCodegen'
  | 'onboardingFinished';

const ONBOARDING_ORDER: ProjectOnboardingState[] = [
  'intake',
  'initialSpecReview',
  'initialCodegen',
  'onboardingFinished',
];

export interface ProjectStatus {
  onboardingState: ProjectOnboardingState;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let status: ProjectStatus = {
  onboardingState: 'intake',
};
let statusFilePath: string;

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

export function initProjectStatus(workspaceDir: string): void {
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
      status = { onboardingState: 'intake' };
    }
  }

  if (status.onboardingState !== 'intake') {
    log.info(`Restored: onboardingState=${status.onboardingState}`);
  }
}

function tryReadStatus(filePath: string): boolean {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    status = {
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

export function getOnboardingState(): ProjectOnboardingState {
  return status.onboardingState;
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
