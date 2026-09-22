/**
 * Initial-build-complete email.
 *
 * Fired exactly once, when a project's genuine first build finishes (the
 * forward-only transition into the `buildComplete` onboarding state — see
 * ProjectStatusManager + the markBuildComplete tool handler). It POSTs
 * to youai-api's `dev/manage/initial-build-complete`, which emails the app
 * creator a "your first build is ready" nudge.
 *
 * The endpoint has NO server-side dedupe — it emails on every successful call —
 * so the exactly-once decision lives entirely on our side (the onboarding gate).
 * This module is invoked fire-and-forget and never throws.
 */

import { createLogger } from '../logger.ts';
import type { HomeSnapshotManager } from './HomeSnapshotManager.ts';

const log = createLogger('initial-build-email');

export interface InitialBuildEmailDeps {
  snapshotManager: HomeSnapshotManager;
  /** App id from the manifest; null if it couldn't be resolved. */
  appId: string | null;
  /** MINDSTUDIO_API_KEY — the user credential the route's edit check accepts. */
  apiKey: string;
  apiBaseUrl: string;
}

// Bounded retry for the pre-POST snapshot. snapshot() returns false immediately
// when another snapshot (the interval timer) is already in progress, and that
// in-flight one may have started before remy wrote the final metadata. So we
// retry briefly to land a fresh commit that carries the real
// name/description/iconUrl, rather than emailing scaffold defaults.
const SNAPSHOT_ATTEMPTS = 6;
const SNAPSHOT_RETRY_DELAY_MS = 750;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function snapshotWithFinalMetadata(
  snapshotManager: HomeSnapshotManager,
): Promise<boolean> {
  for (let attempt = 1; attempt <= SNAPSHOT_ATTEMPTS; attempt++) {
    if (await snapshotManager.snapshot()) {
      return true;
    }
    if (attempt < SNAPSHOT_ATTEMPTS) {
      await delay(SNAPSHOT_RETRY_DELAY_MS);
    }
  }
  return false;
}

/**
 * Snapshot the built project (the commit carries the manifest's display fields,
 * which is where the email reads them from), then POST initial-build-complete.
 * Best-effort: logs and swallows every failure so a transient email problem
 * never affects the build flow.
 */
export async function sendInitialBuildCompleteEmail(
  deps: InitialBuildEmailDeps,
): Promise<void> {
  const { snapshotManager, appId, apiKey, apiBaseUrl } = deps;

  if (!appId) {
    log.warn('Skipping initial-build-complete email: no appId resolved');
    return;
  }

  try {
    // Sequencing requirement: the email's icon/name/description come from the
    // app's draft metadata, which the snapshot commit populates from
    // mindstudio.json. Snapshot first so the email shows the real app, not
    // "Untitled" / no icon.
    const snapshotted = await snapshotWithFinalMetadata(snapshotManager);
    if (!snapshotted) {
      log.warn(
        'Could not confirm a fresh snapshot before initial-build email; ' +
          'proceeding (an earlier snapshot likely already carried current metadata)',
      );
    }

    const url = `${apiBaseUrl}/_internal/v2/apps/${appId}/dev/manage/initial-build-complete`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    });

    if (!res.ok) {
      // 404 app_not_found / 403 forbidden — config/auth issue, not transient.
      // A 403 here is the signal that this route wants a different credential
      // than MINDSTUDIO_API_KEY. Log loudly; do not retry.
      const body = await res.text().catch(() => '');
      log.error(
        `initial-build-complete POST failed: ${res.status} ${body.slice(0, 500)}`,
      );
      return;
    }

    const data = (await res.json().catch(() => ({}))) as {
      sent?: boolean;
      reason?: string;
    };
    if (data.sent) {
      log.info('First-build email sent to creator');
    } else {
      // 200 { sent:false, reason:"send_failed" } — mail provider hiccup the
      // server already logged. Memo: not an error we act on, and we must not
      // retry (no server dedupe → retry would double-send on recovery).
      log.info(
        `First-build email not sent (reason=${data.reason ?? 'unknown'}); not retrying`,
      );
    }
  } catch (err) {
    log.warn(
      `initial-build-complete email errored (swallowed): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
