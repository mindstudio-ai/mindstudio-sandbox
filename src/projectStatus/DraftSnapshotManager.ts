/**
 * Git snapshot manager for the `_draft` branch.
 *
 * Commits all workspace state (files + session state) to a `_draft` branch and
 * force-pushes to the remote. On boot, restores from the draft if one exists.
 * Provides durability against unclean container deaths. Uses git plumbing
 * commands with a temporary index file so snapshots are completely isolated
 * from remy's working tree and any in-progress git ops.
 *
 * Trigger model — everything funnels into the single-flight `snapshot()`, which
 * runs the authoritative `git add -A` and no-ops only when the tree is
 * genuinely unchanged:
 *   - Real workspace changes (editor / agent / external file writes) and agent
 *     turn completion call `scheduleSnapshot()` — a short SNAPSHOT_DEBOUNCE_MS
 *     debounce (so the trailing edit/turn is captured within seconds, before an
 *     abrupt idle-stop can drop it) clamped to SNAPSHOT_MAX_AGE_MS (so sustained
 *     activity still snapshots at a steady cadence rather than deferring).
 *   - A SNAPSHOT_BACKSTOP_MS backstop timer (`start()`) is the safety net: it
 *     catches anything the event triggers missed (e.g. a dropped file-watcher
 *     event) and persists `.logs` diagnostic churn on an otherwise-idle app.
 *   - SIGTERM does a final synchronous `snapshot()` before the pod drains.
 *   - A push-retry timer re-attempts a push deferred by backoff.
 *
 * File-change events deliberately exclude `.logs` (the watcher ignores it), so
 * constant browser/tunnel log writes don't drive snapshots — only the backstop
 * persists them.
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

// Snapshot trigger cadence.
//   - DEBOUNCE: short trailing debounce — the last edit/turn is captured within
//     seconds of activity settling. This is the real durability guarantee: the
//     final snapshot on SIGTERM is unreliable on an idle-stop (see state.ts —
//     "shutdowns where SIGTERM never arrives"), so a slow trailing edge
//     silently loses the last chunk of work (e.g. a tool-only agent turn whose
//     only artifact is the unwatched .remy-session.json).
//   - MAX_AGE: ceiling on the debounce — sustained activity can't defer the
//     snapshot past this, so a continuous stream still snapshots regularly.
//   - BACKSTOP: wall-clock safety net for anything the event triggers missed
//     (dropped watcher events) and to persist idle `.logs` churn.
const SNAPSHOT_DEBOUNCE_MS = 5_000;
const SNAPSHOT_MAX_AGE_MS = 60_000;
const SNAPSHOT_BACKSTOP_MS = 5 * 60_000;

export class DraftSnapshotManager {
  private workspaceDir: string;
  private backstopTimer: ReturnType<typeof setInterval> | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  /** Epoch ms of the first change in the current debounce window, or null when
   * clean. Anchors the SNAPSHOT_MAX_AGE_MS clamp so a steady change stream
   * can't defer the snapshot indefinitely. */
  private debounceSinceMs: number | null = null;
  /** In-flight snapshot run, or null. Same single-flight drop semantics as a
   * boolean flag for snapshot() callers, but awaitable — flushNow() needs to
   * ride out a run that staged pre-quiesce state and then run one more. */
  private inFlight: Promise<boolean> | null = null;
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
  /** Epoch ms before which we must not attempt another push. Set on push
   * failure (exponential backoff + jitter), cleared on success. While inside
   * this window snapshots still commit locally — they just skip the network
   * push so a degraded git endpoint isn't hammered at a fixed cadence. */
  private pushBackoffUntil: number | null = null;
  /** Local `_draft` tip we last successfully pushed. A push is needed only
   * when the current tip differs from this — which is how a deferred push
   * (committed locally, not yet pushed) still gets shipped even when the tree
   * stops changing. */
  private lastPushedSha: string | null = null;
  /** Pending timer that re-attempts a deferred push once the backoff window
   * elapses, independent of the next file/turn trigger. */
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  /** Set on a successful boot restore. `_draft` is latest-wins — rehydration
   * only ever fetches the tip — so its commit history is never read. On the
   * first snapshot after boot we re-root (commit parentless) to drop the
   * remote's unbounded history chain; the git server's gc then reclaims it.
   * Consumed once the re-root commit is created locally. See restore(). */
  private rerootPending = false;

  constructor(workspaceDir: string) {
    this.workspaceDir = workspaceDir;
  }

  /** Start the backstop timer — the safety net that snapshots any changes the
   * event triggers missed, and persists `.logs` churn on an otherwise-idle
   * app. Real changes and turns snapshot far sooner via `scheduleSnapshot`. */
  start(intervalMs = SNAPSHOT_BACKSTOP_MS): void {
    if (this.backstopTimer) {
      return;
    }
    log.info(`Starting snapshot backstop every ${intervalMs / 1000}s`);
    this.backstopTimer = setInterval(() => {
      this.snapshot().catch(() => {});
    }, intervalMs);
    this.backstopTimer.unref();
  }

  /** Stop the backstop, the debounce, and the push-retry timers. */
  stop(): void {
    if (this.backstopTimer) {
      clearInterval(this.backstopTimer);
      this.backstopTimer = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.debounceSinceMs = null;
    this.clearRetryTimer();
  }

  /**
   * Schedule a debounced snapshot in response to a real workspace change or a
   * completed agent turn. Reset-per-change but clamped: the timer fires
   * SNAPSHOT_DEBOUNCE_MS after the most recent change (so the trailing edit/turn
   * is captured within seconds — the durability guarantee, since the final
   * snapshot on SIGTERM can't be relied on), but never later than
   * SNAPSHOT_MAX_AGE_MS after the first pending change (so a sustained stream
   * still snapshots at a steady cadence). Mirrors youai-api's
   * DraftSyncStore.scheduleFlush. The backstop covers anything not routed here.
   */
  scheduleSnapshot(): void {
    if (this.debounceSinceMs === null) {
      this.debounceSinceMs = Date.now();
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    const dirtyAge = Date.now() - this.debounceSinceMs;
    if (dirtyAge >= SNAPSHOT_MAX_AGE_MS) {
      this.debounceSinceMs = null;
      this.snapshot().catch(() => {});
      return;
    }
    const delay = Math.min(
      SNAPSHOT_DEBOUNCE_MS,
      SNAPSHOT_MAX_AGE_MS - dirtyAge,
    );
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.debounceSinceMs = null;
      this.snapshot().catch(() => {});
    }, delay);
    this.debounceTimer.unref();
  }

  /** Return snapshot health info for the /status endpoint. */
  getSnapshotStatus() {
    return {
      inProgress: this.inFlight !== null,
      lastAttemptAt: this.lastAttemptAt,
      lastSuccessAt: this.lastSuccessAt,
      lastDurationMs: this.lastDurationMs,
      lastError: this.lastError,
      lastRestoreOutcome: this.lastRestoreOutcome,
      consecutivePushFailures: this.consecutivePushFailures,
      pushBackoffUntil: this.pushBackoffUntil,
    };
  }

  /** Take a snapshot: commit workspace to _draft and force-push. */
  async snapshot(): Promise<boolean> {
    if (this.inFlight) {
      log.debug('Snapshot already in progress, skipping');
      return false;
    }
    this.inFlight = this.doSnapshot().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  /**
   * Pre-destroy flush: guarantee one full snapshot runs to completion from
   * this moment. Unlike snapshot() (which drops when a run is in flight — and
   * a run that started earlier may have staged state from before the caller's
   * quiesce), this awaits any in-flight run and then runs one more. Absorbs a
   * pending debounce and clears the push backoff — a local-only commit is
   * worthless when the container is about to be destroyed, so the push must
   * be attempted now.
   */
  async flushNow(): Promise<boolean> {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.debounceSinceMs = null;
    if (this.inFlight) {
      await this.inFlight.catch(() => false);
    }
    this.pushBackoffUntil = null;
    // Coalesce with a racing starter: a run that began during our await
    // started after the caller's quiesce, so its state is current — ride it.
    return this.inFlight ?? this.snapshot();
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
      // `--depth=1`: restore only needs the latest snapshot's tree, and the
      // first post-restore snapshot deltas against the fetched tip (seeded
      // below) — neither needs the full `_draft` commit chain. Fetching just
      // the tip keeps a cold boot fast regardless of how deep history grew.
      const fetched = await this.exec(
        `git fetch --no-tags --depth=1 origin +${DRAFT_BRANCH}:${REMOTE_DRAFT_REF}`,
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

    // Re-root `_draft` on boot. It's latest-wins — rehydration only ever
    // fetches the tip (`--depth=1` above), so the commit history is never
    // read. If we seeded the local branch at the fetched tip and parented the
    // next snapshot on it, the remote's full chain would stay reachable
    // forever: tens of thousands of snapshots of large session/log state that
    // nothing reads, bloating the server repo until its gc/tar/upload starve
    // the per-repo push lock (gateway timeouts). Instead, leave
    // `refs/heads/_draft` unset so the first snapshot commits parentless (see
    // doSnapshot); its force-push replaces the remote tip with a fresh root,
    // orphaning the old chain so the git server's gc reclaims it. Cost: that
    // first push re-uploads the full tree (no delta); every snapshot after
    // parents on the new root and deltas as before. Boot-only, so the
    // full-upload cost is paid at most once per session.
    //
    // NB: intentionally do NOT record draftSha as lastPushedSha — the re-root
    // must push even when the tree is unchanged, to drop the remote history.
    this.rerootPending = true;

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

    // Decide whether a new commit is needed. If the tree is identical to the
    // one we last committed, skip creating a redundant commit — but do NOT
    // return here: a prior commit may have been committed locally and never
    // pushed (a push deferred by backoff), and that still has to ship. The
    // push decision below is driven by lastPushedSha, not the tree.
    let draftSha: string;
    if (this.lastTreeSha && treeSha === this.lastTreeSha) {
      this.cleanupTmpIndex();
      const head = await this.exec(`git rev-parse ${DRAFT_REF}`);
      if (!head.ok || !head.stdout.trim()) {
        // No local _draft and nothing changed — genuinely nothing to do.
        return true;
      }
      draftSha = head.stdout.trim();
    } else {
      // Parent on the current _draft tip so git delta-compresses the push —
      // only changed objects are transferred. EXCEPT on the first snapshot
      // after a boot restore, where we deliberately re-root (commit parentless)
      // to drop _draft's never-read history so the server can reclaim it (see
      // restore()). A parent is otherwise absent only on a truly fresh app.
      let parentFlag = '';
      if (this.rerootPending) {
        log.info(
          'Re-rooting _draft on boot — dropping history; this push re-uploads the full tree (no delta)',
        );
      } else {
        const parentResult = await this.exec(`git rev-parse ${DRAFT_REF}`);
        const parent = parentResult.ok ? parentResult.stdout.trim() : '';
        parentFlag = parent ? `-p ${parent}` : '';
      }
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

      // Point _draft ref at the new commit. This is the durability point: the
      // user's work is now safe on the local _draft regardless of whether the
      // push below happens now or is deferred by backoff.
      const updateRef = await this.exec(
        `git update-ref ${DRAFT_REF} ${commitSha}`,
      );
      if (!updateRef.ok) {
        this.lastError = 'could not update ref';
        log.error('Snapshot failed: could not update ref');
        return false;
      }
      this.lastTreeSha = treeSha;
      // Re-root consumed: subsequent snapshots parent on this new root and
      // delta as normal. Cleared only after the commit is durable locally, so
      // a failed commit/update-ref above retries the re-root next cycle. Even
      // if the push is deferred by backoff, the local chain is now orphan-
      // rooted, so whenever it lands it re-roots the remote.
      this.rerootPending = false;
      this.cleanupTmpIndex();
      draftSha = commitSha;
    }

    // Already synced — the remote has this exact tip. Nothing to push.
    if (draftSha === this.lastPushedSha) {
      log.debug('Local _draft already pushed; nothing to sync');
      this.lastError = null;
      return true;
    }

    // Back off a degraded git endpoint. The commit above is already durable
    // locally, so deferring the push loses nothing — whenever it next succeeds
    // it carries the latest committed state. Skip the push inside the backoff
    // window and let the retry timer fire once the window elapses.
    const now = Date.now();
    if (this.pushBackoffUntil !== null && now < this.pushBackoffUntil) {
      log.info(
        `Committed locally; deferring push ~${Math.round((this.pushBackoffUntil - now) / 1000)}s ` +
          `(backoff, consecutivePushFailures=${this.consecutivePushFailures})`,
      );
      this.scheduleRetryAfterBackoff();
      return false;
    }

    // One push attempt per cycle — deliberately no immediate retry. A failed
    // push still makes the server do work, so back-to-back retries against a
    // struggling endpoint only amplify and prolong the outage. The `+` forces
    // the update and never deletes the remote ref, so a failed push can't
    // destroy the last good snapshot; spacing is handled by the backoff below.
    const pushed = await this.exec(
      `git push origin +${DRAFT_REF}:${DRAFT_REF}`,
    );
    if (!pushed.ok) {
      this.consecutivePushFailures++;
      this.pushBackoffUntil = Date.now() + this.computePushBackoffMs();
      this.lastError = 'push failed';
      log.warn(
        `Snapshot committed locally but push failed ` +
          `(consecutivePushFailures=${this.consecutivePushFailures}, ` +
          `next attempt in ~${Math.round((this.pushBackoffUntil - Date.now()) / 1000)}s)`,
      );
      this.scheduleRetryAfterBackoff();
      return false;
    }

    // Success — clear the backoff and record what we pushed.
    this.consecutivePushFailures = 0;
    this.pushBackoffUntil = null;
    this.clearRetryTimer();
    this.lastPushedSha = draftSha;

    const elapsed = Date.now() - startTime;
    this.lastSuccessAt = Date.now();
    this.lastDurationMs = elapsed;
    this.lastError = null;
    log.info(`Snapshot completed in ${elapsed}ms (${draftSha.slice(0, 8)})`);
    return true;
  }

  /** Remove the temp index file (best-effort; absence is fine). */
  private cleanupTmpIndex(): void {
    try {
      fs.unlinkSync(TMP_INDEX);
    } catch {
      // doesn't exist, fine
    }
  }

  /**
   * Backoff before the next push attempt, in ms: exponential in the number of
   * consecutive failures (2s, 4s, 8s, …) capped at 60s, with full jitter
   * across [delay/2, delay] so many sandboxes backing off a shared endpoint
   * don't resynchronize into retry waves.
   */
  private computePushBackoffMs(): number {
    const BASE_MS = 2_000;
    const CAP_MS = 60_000;
    const exp = Math.min(
      CAP_MS,
      BASE_MS * 2 ** (this.consecutivePushFailures - 1),
    );
    return Math.round(exp / 2 + Math.random() * (exp / 2));
  }

  /**
   * Ensure a single pending timer re-attempts the deferred push once the
   * backoff window elapses — otherwise a deferred push would wait for the next
   * file/turn trigger or the backstop tick. At most one is scheduled.
   */
  private scheduleRetryAfterBackoff(): void {
    if (this.retryTimer) {
      return;
    }
    const now = Date.now();
    const waitMs = Math.max(0, (this.pushBackoffUntil ?? now) - now) + 250;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.snapshot().catch(() => {});
    }, waitMs);
    this.retryTimer.unref();
  }

  /** Cancel any pending backoff-retry timer. */
  private clearRetryTimer(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
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
