/**
 * Project status tracking.
 *
 * Manages onboarding state — which phase of the guided onboarding flow
 * the project is in. Persisted to `.project-status.json` so it survives
 * snapshots.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '../logger.ts';

const log = createLogger('project');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProjectOnboardingState =
  | 'intake'
  | 'building'
  | 'buildComplete'
  | 'onboardingFinished';

const ONBOARDING_ORDER: ProjectOnboardingState[] = [
  'intake',
  'building',
  'buildComplete',
  'onboardingFinished',
];

// Removed states that still appear in persisted .project-status.json files
// from before the onboarding-flow overhaul. On read, these normalize to
// 'onboardingFinished' so users past intake aren't dumped back to the start.
const LEGACY_STATES_TO_FINISHED = new Set([
  'initialSpecReview',
  'initialCodegen',
]);

export interface ProjectStatus {
  onboardingState: ProjectOnboardingState;
}

/**
 * Whether a value is live onboarding vocabulary. Deliberately rejects the two
 * legacy states above — those are normalized on read from disk, and nothing
 * should be able to introduce one from outside this module.
 */
export const isProjectOnboardingState = (
  value: unknown,
): value is ProjectOnboardingState =>
  typeof value === 'string' &&
  (ONBOARDING_ORDER as readonly string[]).includes(value);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let status: ProjectStatus = {
  onboardingState: 'intake',
};
let statusFilePath: string;

/**
 * Called after a real state change, so the snapshot manager can mirror it to the
 * platform promptly instead of waiting for an unrelated edit to trigger a cycle.
 *
 * A registered hook rather than a direct call because `HomeSnapshotManager`
 * imports THIS module (it sends the state on every commit), and importing it
 * back would be a cycle. Wired in index.ts alongside the manager's construction.
 */
let onStateChanged: (() => void) | null = null;

export function setOnboardingChangeListener(fn: (() => void) | null): void {
  onStateChanged = fn;
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

/**
 * Load this app's onboarding phase.
 *
 * `platformState` is the platform's durable copy (see the snapshot read in
 * `HomeSnapshotManager`), used when the workspace has no status file of its own.
 * That is not an edge case: `.project-status.json` lives only in the workspace
 * snapshot, never in git, so EVERY box on the clone path arrives without it —
 * somebody's first box on a colleague's app, a fork, or a snapshot read that
 * came back empty. Defaulting to `intake` there drops an app with hundreds of
 * methods and a live release into onboarding with an empty chat, which is what
 * happened to app 7eb8cbb7 on 2026-09-13.
 *
 * The local file still wins when present, because it is what the box itself last
 * wrote and it cannot be stale relative to this box's own work. The platform's
 * copy is the fallback, not the authority.
 *
 * Null from the platform means "no opinion" — every app predating the column —
 * and lands on `intake` exactly as before, so this is additive.
 */
export function initProjectStatus(
  workspaceDir: string,
  platformState?: ProjectOnboardingState | null,
): void {
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
    } else if (platformState) {
      log.info(`No status file; adopting platform state "${platformState}"`);
      status = { onboardingState: platformState };
      // Written now rather than left in memory, so the value rides this box's
      // first snapshot and every later boot restores it like any other.
      flush();
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
    const parsedState = parsed.onboardingState;
    let resolved: ProjectOnboardingState;
    let migrated = false;
    if (ONBOARDING_ORDER.includes(parsedState)) {
      resolved = parsedState;
    } else if (LEGACY_STATES_TO_FINISHED.has(parsedState)) {
      resolved = 'onboardingFinished';
      migrated = true;
      log.info(
        `Migrating legacy onboardingState "${parsedState}" → "onboardingFinished"`,
      );
    } else {
      // A file that parses but names a phase we do not recognise — a garbled
      // write, or a value from a build this one has been rolled back past. Read
      // as a FAILED read rather than resolved to `intake`, so the caller falls
      // through to the platform's copy: guessing `intake` for an app we cannot
      // place is the failure this whole path exists to avoid, and the platform
      // knows better than a file we just failed to understand.
      log.warn(
        `Unrecognized onboardingState "${String(parsedState)}" in ${filePath}`,
      );
      return false;
    }
    status = { onboardingState: resolved };
    if (migrated) {
      // Persist normalization so we don't re-migrate on every boot.
      try {
        fs.writeFileSync(filePath, JSON.stringify(status), 'utf-8');
      } catch {
        // non-fatal — the in-memory state is correct, next flush() writes it
      }
    }
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

/**
 * Whether `initProjectStatus` has run, i.e. whether `getOnboardingState()` is a
 * loaded value rather than the module's `intake` placeholder.
 *
 * Exists for one caller: the snapshot commit, which reports the state to the
 * platform and must not report a placeholder. A SIGTERM flush can land before
 * step 7 of the boot, and while the platform's write is forward-only (so a stray
 * `intake` could only ever move an app that has no recorded state at all), an
 * unfounded value is better omitted than sent — the same call omits
 * `uncompressedBytes` for the same reason.
 */
export function isProjectStatusInitialized(): boolean {
  return statusFilePath !== undefined;
}

/**
 * Re-read `.project-status.json` from disk. Used by the file watcher when
 * the file is written externally (e.g. remy writes it directly, or a draft
 * snapshot restore overwrote it). Returns true if the onboarding state
 * actually changed — callers use this to decide whether to broadcast.
 */
export function reloadProjectStatus(): boolean {
  const before = status.onboardingState;
  tryReadStatus(statusFilePath);
  return status.onboardingState !== before;
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
  // Never let a listener's failure lose the transition — the file is already
  // written, and the mirror self-heals on the next commit either way.
  try {
    onStateChanged?.();
  } catch (err) {
    log.warn(`Onboarding change listener failed: ${String(err)}`);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function flush(): void {
  fs.writeFileSync(statusFilePath, JSON.stringify(status), 'utf-8');
}
