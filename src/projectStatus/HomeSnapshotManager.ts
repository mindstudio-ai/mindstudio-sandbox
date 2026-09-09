/**
 * Workspace snapshots: the box's home directory, tarred to S3.
 *
 * `/home/remy` is the user's computer and the image is the platform's, so the
 * snapshot is that directory minus what can be rebuilt from it — see
 * SNAPSHOT_EXCLUDES. Everything else goes in without interpretation: workspace,
 * .git, dotfiles, logs. Restore is untar and go. What the platform needs to
 * know about the contents (the manifest's display fields, the presentation
 * sources, the usage ledger) is sent with each commit rather than read out of
 * the blob.
 *
 * Cadence: on SIGTERM (the pod's grace period bounds the flush) and every
 * SNAPSHOT_INTERVAL_MS while anything under home changed, detected by a mtime
 * walk against a marker touched at the start of each upload. Kubernetes
 * delivers SIGTERM on every platform-initiated stop, so a crash between
 * intervals is the only way to lose work, and the entrypoint's supervisor
 * restarts the server in place for the common case of that.
 *
 * Writes are two-phase against youai-api (begin → PUT → commit) and the commit
 * only succeeds for the app's newest session. A 409 on either call means this
 * box has been superseded: it fences itself and never writes again, so a
 * replaced box cannot overwrite its successor's work.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createLogger } from '../logger.js';
import { makeCounterEmitter } from '../bootProgress.js';

const log = createLogger('snapshot');

const SNAPSHOT_INTERVAL_MS = 5 * 60_000;

//////////////////////////////////////////////////////////////////////////////
// What a snapshot is NOT
//
// The snapshot preserves the user's work. These three paths are not it — they are derived from it, or
// they are ours — and on a real customer app they were 96% of the bytes: node_modules 645 MB, the npm
// cache 109 MB, against 30 MB of actual repo. Tarring home whole cost 10.4s and produced a 217 MB
// object; excluding these cost 0.9s and produced 9 MB. That is the difference between a shutdown
// flush that fits inside the pod's grace period and one that races it.
//
//   node_modules   Rebuilt by the `npm install` that already runs on every boot (bootstrap's
//                  installDependencies), from a lockfile the repo carries. Restoring it only ever
//                  made that install a no-op.
//   .npm           npm's own download cache. Measured worth: 900ms of a 6s install.
//   .npm-global    PLATFORM tooling, not the user's. It rides first on PATH, so a copy frozen here
//                  shadows the image's — which is exactly the bug installAgentSdk still evicts
//                  per-package. Excluding it stops making new ones.
//
// Consumed by BOTH the tar and the change detector, deliberately: they answer the same question, and
// a change detector that watches paths the tar ignores wakes up to upload nothing.
//
// Anchoring is load-bearing and the two halves differ. `./.npm` must be anchored or it would also
// match a `.npm` directory inside the user's project and silently drop their data; `node_modules`
// must NOT be, so it matches at every depth. GNU tar applies --anchored to the patterns that FOLLOW
// it, so the order below is the meaning. Verified against GNU tar 1.35: `./.npm/`, `./.npm-global/`
// and node_modules at three different depths all dropped, `./workspace/.npm/user-data.json` kept.
//////////////////////////////////////////////////////////////////////////////
const SNAPSHOT_EXCLUDES = {
  /** Home-relative, matched from the start of the member name. */
  anchored: ['./.npm', './.npm-global'],
  /** Matched against any path component, at any depth. */
  anywhere: ['node_modules'],
};

const TAR_EXCLUDE_ARGS = [
  '--anchored',
  ...SNAPSHOT_EXCLUDES.anchored.map((p) => `--exclude=${p}`),
  '--no-anchored',
  ...SNAPSHOT_EXCLUDES.anywhere.map((p) => `--exclude=${p}`),
];
// Outside home so it is never inside the tar, and inside the container's own
// filesystem so it survives an in-place server restart but not a new pod.
const CHANGE_MARKER = '/tmp/.snapshot-marker';
const BOOTED_MARKER = '/tmp/.cnc-booted';
const SNAPSHOT_TAR = '/tmp/snapshot.tar.zst';
const RESTORE_TAR = '/tmp/restore.tar.zst';
const RESTORE_RETRY_BACKOFFS_MS = [2_000, 6_000, 18_000];
const HTTP_TIMEOUT_MS = 30_000;
const TRANSFER_TIMEOUT_MS = 10 * 60_000;

//////////////////////////////////////////////////////////////////////////////
// Extract progress
//
// GNU tar's `--checkpoint=N --checkpoint-action=echo=%u` prints the number of RECORDS processed
// every N of them. A record is `blocking factor × 512` bytes, and the blocking factor is passed
// explicitly below rather than left to the default so this arithmetic is pinned rather than
// assumed — the whole point is that the figure the display divides by is the one tar is counting.
// 20 IS the default, so pinning it changes nothing about how the archive is read.
//
// Records, not files: there is no way to get a file count out of tar without `-v`, which prints a
// line per member. On a few hundred thousand files that is both a flood on a 500ms-batched wire and
// measurable overhead on the phase this exists to make feel shorter.
//
// The interval is in records so it scales with the archive rather than with the file count: 4096
// records is ~40 MiB, so a 1 GiB home reports about 25 times over ~16s, and the client interpolates
// between them.
//////////////////////////////////////////////////////////////////////////////
const TAR_BLOCKING_FACTOR = 20;
const TAR_RECORD_BYTES = TAR_BLOCKING_FACTOR * 512;
const TAR_CHECKPOINT_RECORDS = 4096;

/** One MiB-formatted figure, for log lines a person reads. */
const mib = (bytes: number): string =>
  `${(bytes / 1024 / 1024).toFixed(1)} MiB`;

/**
 * Bytes processed, from a checkpoint line, or null when the line isn't one.
 *
 * `--checkpoint-action=echo=%u` does NOT emit a bare number: GNU tar prefixes its own name, so the
 * line is `tar: 4096`. Requiring a bare number silently discarded every checkpoint and the extract
 * bar never moved — the one assumption in this file that could not be checked without GNU tar, and
 * it was wrong. Measured against GNU tar 1.35: prefix present, and `%u` counts records of the
 * UNCOMPRESSED stream (a 301 MiB home compressing to 20 KiB still reported 28,672 records ≈ 293.6
 * MiB at 10,240 bytes each), which is what makes `uncompressedBytes` the right denominator.
 *
 * Still strict about the rest, because tar writes other things to stderr (`--warning` output, real
 * errors) and a loose parse would move the progress bar backwards.
 */
function recordsToBytes(line: string): number | null {
  const match = /^(?:tar: )?(\d+)$/.exec(line.trim());
  if (!match) {
    return null;
  }
  return Number(match[1]) * TAR_RECORD_BYTES;
}

/**
 * Uncompressed byte total, from GNU tar's `--totals` line on the WRITE side.
 *
 * Format is `Total bytes written: 1234567890 (1.2GiB, 45MiB/s)`. Parsed rather than computed
 * because it is the only authoritative figure for what the next boot has to unpack, and a streamed
 * zstd frame's header carries no decompressed size. Null when the line isn't there or changes
 * shape, which costs the next boot its progress bar and nothing else.
 */
function parseTarTotalBytes(stderr: string): number | null {
  const m = stderr.match(/Total bytes written:\s*(\d+)/);
  return m ? Number(m[1]) : null;
}

// Presentation sources youai-api assembles into the dashboard's draft view.
// The roadmap's item files are discovered under src/roadmap at snapshot time.
const PRESENTATION_FIXED_PATHS = [
  'src/overview.html',
  'src/roadmap/pitch.html',
  'src/roadmap/index.json',
];
// The commit is a JSON body under youai-api's 10 MB limit; a presentation that
// would not fit is skipped (the draft view goes stale, not wrong).
const PRESENTATION_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Outcome of `prepareHome()`.
 *
 * - `resumed`: an in-place restart of the server inside a running pod. Local
 *   state is newer than anything in S3, so nothing was fetched.
 * - `restored`: a snapshot existed and home was rebuilt from it.
 * - `no_snapshot`: the app has never had one. The caller clones the repo and
 *   tries the legacy `_draft` branch.
 * - `unresolvable`: a snapshot may exist but could not be fetched or applied.
 *   The caller MUST NOT proceed to scaffold state — the user's work would be
 *   silently overwritten by the next upload.
 */
export type RestoreResult =
  | 'resumed'
  | 'restored'
  | 'no_snapshot'
  | 'unresolvable';

/**
 * What a snapshot run did.
 *
 * - `committed`: a new snapshot is durable in S3 and is now the app's current one.
 * - `unchanged`: nothing under home changed since the last one, which is already current.
 * - `failed`: the tar, the upload or the commit did not succeed. `lastError` says why.
 * - `fenced`: another box took this BRANCH after us and has committed on it, so its snapshots are
 *   no longer ours to write. Per branch and recoverable, unlike a terminal state: checking out
 *   somewhere else clears it (see `isFenced`).
 *
 * The first two are both success for a caller asking "is the user's work safe" —
 * see `isSafe`.
 */
export type SnapshotOutcome = 'committed' | 'unchanged' | 'failed' | 'fenced';

/** Whether an outcome means the user's work is durable in S3. */
export const isSafe = (outcome: SnapshotOutcome): boolean =>
  outcome === 'committed' || outcome === 'unchanged';

export interface HomeSnapshotManagerOptions {
  homeDir: string;
  workspaceDir: string;
  appId: string;
  sessionId: string;
  apiBaseUrl: string;
  apiKey: string;
  /**
   * The branch HEAD is on right now, read at snapshot time rather than captured once.
   *
   * A snapshot belongs to a branch, and the branch moves during a session — so asking at the moment
   * of the write is the only way to file it correctly. Passed in rather than read from the server
   * context so this class keeps taking its dependencies explicitly. Optional, and absent means
   * "platform, use what you have recorded".
   */
  getBranch?: () => string | null;
  /** Fired on health transitions (failing / recovered / fenced) so the C&C
   * server can broadcast fresh status to editor clients. */
  onStatusChange?: () => void;
}

interface CurrentSnapshot {
  snapshotId: string;
  bytes: number | null;
  /** Absent from snapshots committed before boxes reported it. See TAR_RECORD_BYTES. */
  uncompressedBytes?: number | null;
  sha256: string | null;
  downloadUrl: string;
}

class SupersededError extends Error {
  constructor() {
    super('superseded by a newer sandbox session');
    this.name = 'SupersededError';
  }
}

export class HomeSnapshotManager {
  private readonly homeDir: string;
  private readonly workspaceDir: string;
  private readonly appId: string;
  private readonly sessionId: string;
  private readonly apiBaseUrl: string;
  private readonly apiKey: string;
  private readonly getBranch: (() => string | null) | null;
  private readonly onStatusChange: (() => void) | null;

  private intervalTimer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  /** In-flight run, or null. Awaitable so flushNow() can ride out a run that
   * started before the caller's quiesce and then run one more. */
  private inFlight: Promise<SnapshotOutcome> | null = null;
  /** Upload even when the change walk finds nothing — set after a legacy
   * `_draft` restore so the first snapshot seeds S3 for this app. */
  private forceUpload = false;
  private lastAttemptAt: number | null = null;
  private lastSuccessAt: number | null = null;
  private lastDurationMs: number | null = null;
  private lastError: string | null = null;
  private lastRestoreOutcome: RestoreResult | null = null;
  /** Consecutive failed uploads (resets on success). Surfaced through /status
   * and the editor's TopBar so silent rot is at least visible. */
  private consecutivePushFailures = 0;
  /** Epoch ms before which no upload is attempted (exponential backoff with
   * jitter after a failure). A degraded endpoint is not hammered every tick. */
  private pushBackoffUntil: number | null = null;
  /**
   * The branch this box has been fenced OFF, or null.
   *
   * Per branch, not per box. A 409 means "another box took this branch after you", which is a fact
   * about one branch rather than about this process — and it is recoverable, because a box that
   * switches back to a branch it still owns may write again. As a permanent per-box latch it meant
   * losing one branch silently disabled saving for the box's whole life, including its SIGTERM
   * flush: the save that matters most, on work the user could still see on screen.
   *
   * Cleared when HEAD lands somewhere else (see `noteBranch`), which is also what makes the
   * "another box owns this branch" state in the editor go away on its own.
   */
  private fencedBranch: string | null = null;
  /** Content hash of the presentation sources at the last commit that carried
   * them; they are re-sent only when it changes. */
  private lastPresentationHash: string | null = null;
  /** size:mtime of the usage ledger at its last upload. */
  private lastLedgerStamp: string | null = null;
  /** One clause describing the restore, for the boot display. Null until one runs. */
  private restoreSummary: string | null = null;
  /** Uncompressed size of the archive this box last WROTE, sent with its commit so the next boot
   * has a denominator for the extract. Null until a snapshot is tarred, and null forever if tar's
   * `--totals` output can't be parsed — the display degrades to a bare count. */
  private lastUncompressedBytes: number | null = null;
  /** Whether the one-per-box composition line has been emitted. See logCompositionOnce. */
  private loggedComposition = false;

  constructor(opts: HomeSnapshotManagerOptions) {
    this.homeDir = opts.homeDir;
    this.workspaceDir = opts.workspaceDir;
    this.appId = opts.appId;
    this.sessionId = opts.sessionId;
    this.apiBaseUrl = opts.apiBaseUrl.replace(/\/$/, '');
    this.apiKey = opts.apiKey;
    this.getBranch = opts.getBranch ?? null;
    this.onStatusChange = opts.onStatusChange ?? null;
  }

  /**
   * Whether the branch HEAD is on right now is one another box has taken from us.
   *
   * Compared against live HEAD rather than remembered as a flag, so a checkout back to a branch this
   * box still owns clears it with no further plumbing — the platform's answer for that branch has
   * not changed, and asking again is the only way to find out. A null `getBranch` (no watcher) reads
   * as fenced only if we were fenced with no branch to attribute it to, which cannot happen once the
   * watcher is wired.
   */
  private isFenced(): boolean {
    if (!this.fencedBranch) {
      return false;
    }
    const head = this.getBranch?.() ?? null;
    if (head && head !== this.fencedBranch) {
      log.info(
        `HEAD moved to ${head}; ${this.fencedBranch} is somebody else's but this one is ours`,
      );
      this.fencedBranch = null;
      this.onStatusChange?.();
      return false;
    }
    return true;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  start(intervalMs = SNAPSHOT_INTERVAL_MS): void {
    if (this.intervalTimer) {
      return;
    }
    log.info(`Snapshotting home every ${intervalMs / 1000}s when changed`);
    this.intervalTimer = setInterval(() => {
      this.snapshot().catch(() => {});
    }, intervalMs);
    this.intervalTimer.unref();
  }

  stop(): void {
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
    this.clearRetryTimer();
  }

  /** Upload on the next snapshot even if nothing changed. */
  forceNextUpload(): void {
    this.forceUpload = true;
  }

  /** Record that this container has completed a boot, so a later in-place
   * restart of the server resumes local state instead of restoring over it. */
  markBooted(): void {
    fs.writeFileSync(BOOTED_MARKER, String(Date.now()));
  }

  /** Size and duration of this boot's restore, for the boot display. Null when none ran. */
  getRestoreSummary(): string | null {
    return this.restoreSummary;
  }

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
      fenced: this.isFenced(),
      /** Which branch was lost, so the editor can name it rather than saying "backups are off". */
      fencedBranch: this.fencedBranch,
    };
  }

  // ---------------------------------------------------------------------------
  // Snapshot
  // ---------------------------------------------------------------------------

  /**
   * Snapshot if anything changed — the interval timer's entry point.
   * Single-flight: drops when a run is live, and honours the failure backoff.
   * Returns whether the user's work is durable (see `isSafe`).
   */
  async snapshot(): Promise<boolean> {
    if (this.isFenced()) {
      log.debug(
        `Another box owns ${this.fencedBranch}; refusing to snapshot it`,
      );
      return false;
    }
    if (this.inFlight) {
      log.debug('Snapshot already in progress, skipping');
      return false;
    }
    const now = Date.now();
    if (this.pushBackoffUntil !== null && now < this.pushBackoffUntil) {
      log.debug(
        `Deferring snapshot ~${Math.round((this.pushBackoffUntil - now) / 1000)}s (backoff)`,
      );
      this.scheduleRetryAfterBackoff();
      return false;
    }
    return isSafe(await this.runSnapshot());
  }

  /**
   * Snapshot NOW and report what happened — what the platform calls before it
   * deletes the pod, and what SIGTERM runs. Awaits any in-flight run (which may
   * have staged state from before the caller's quiesce) and then runs one more,
   * ignoring the failure backoff: a deferred upload is worthless when the box
   * is about to go away.
   *
   * Unlike `snapshot()` this reports `unchanged` distinctly, so a caller can
   * tell "nothing needed saving" from "saved it" — and, crucially, from
   * `failed`, which is the answer the platform must not mistake for success.
   */
  async flushNow(): Promise<SnapshotOutcome> {
    if (this.isFenced()) {
      log.warn(`Another box owns ${this.fencedBranch}; refusing to flush it`);
      return 'fenced';
    }
    if (this.inFlight) {
      await this.inFlight.catch(() => 'failed' as SnapshotOutcome);
    }
    this.pushBackoffUntil = null;
    // Coalesce with a racing starter: a run that began during our await
    // started after the caller's quiesce, so its state is current — ride it.
    return this.inFlight ?? this.runSnapshot();
  }

  /** Single-flight wrapper around `doSnapshot`. */
  private runSnapshot(): Promise<SnapshotOutcome> {
    this.inFlight = this.doSnapshot().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async doSnapshot(): Promise<SnapshotOutcome> {
    const startTime = Date.now();
    this.lastAttemptAt = startTime;

    if (!this.forceUpload && !(await this.changedSinceMarker())) {
      log.debug('Nothing changed under home; skipping snapshot');
      return 'unchanged';
    }
    // Touch before tarring so writes that land mid-tar are caught next cycle.
    await this.touchMarker();

    // The branch HEAD is on RIGHT NOW, which is the history this snapshot joins. Read from the
    // watcher rather than left to the platform's record of it: a checkout since the last report
    // would otherwise file this work under the branch the box has just left, where nothing looks
    // for it. Read out here so the catch below can name the branch a 409 was about.
    const branch = this.getBranch?.() ?? null;

    try {
      log.info('Starting snapshot...');
      const { bytes, sha256 } = await this.tarHome();
      log.info(
        `Home tarred: ${(bytes / 1024 / 1024).toFixed(1)} MiB in ${Date.now() - startTime}ms`,
      );

      const begun = await this.api<{
        snapshotId: string;
        uploadUrl: string;
        usageLedgerUploadUrl: string;
      }>('POST', '/begin', {
        sessionId: this.sessionId,
        ...(branch ? { branch } : {}),
      });

      await putFile(begun.uploadUrl, SNAPSHOT_TAR, 'application/zstd');
      // Best-effort, and deliberately so: the ledger is telemetry for a dashboard, and `putFile`
      // throws on any non-2xx. Awaited bare, one transient failure on it aborted the run between a
      // successful tar upload and its commit — so the uploaded object was swept as an abandoned
      // pending row. On the interval that costs a retry; on the SIGTERM flush it cost the session's
      // work, for a cost figure.
      await this.uploadUsageLedgerIfChanged(begun.usageLedgerUploadUrl).catch(
        (err) =>
          log.warn(
            `Usage ledger upload failed; keeping the snapshot: ${err instanceof Error ? err.message : String(err)}`,
          ),
      );
      this.logCompositionOnce();

      const presentation = await this.presentationIfChanged();
      await this.api('POST', '/commit', {
        snapshotId: begun.snapshotId,
        sessionId: this.sessionId,
        bytes,
        sha256,
        // Omitted rather than sent as null when tar's `--totals` line couldn't be read: the route
        // treats absent as "unknown" and stores NULL, and the next boot shows a rising figure with
        // no bar. A wrong denominator would be worse than no denominator.
        ...(this.lastUncompressedBytes !== null
          ? { uncompressedBytes: this.lastUncompressedBytes }
          : {}),
        manifest: await this.readManifestFields(),
        ...(presentation ? { presentation: presentation.sources } : {}),
      });
      if (presentation) {
        this.lastPresentationHash = presentation.hash;
      }

      const recovered = this.consecutivePushFailures > 0;
      this.consecutivePushFailures = 0;
      this.pushBackoffUntil = null;
      this.clearRetryTimer();
      this.forceUpload = false;
      this.lastSuccessAt = Date.now();
      this.lastDurationMs = this.lastSuccessAt - startTime;
      this.lastError = null;
      log.info(
        `Snapshot ${begun.snapshotId.slice(0, 8)} committed in ${this.lastDurationMs}ms`,
      );
      if (recovered) {
        this.onStatusChange?.();
      }
      return 'committed';
    } catch (err) {
      if (err instanceof SupersededError) {
        // Scoped to the branch we were trying to write, and the interval keeps running: switching
        // back to a branch this box still owns has to be able to recover, and the editor needs the
        // next tick to notice when it does.
        const lost = branch ?? this.getBranch?.() ?? null;
        log.error(
          `Another box took ${lost ?? 'this branch'} for ${this.appId}; not writing its snapshots until HEAD moves`,
        );
        this.fencedBranch = lost;
        this.lastError = err.message;
        this.onStatusChange?.();
        return 'fenced';
      }
      // Something changed since the marker was touched (the failed upload's
      // state); make sure the next tick retries even if the tree is quiet.
      this.forceUpload = true;
      this.consecutivePushFailures++;
      this.pushBackoffUntil = Date.now() + this.computePushBackoffMs();
      this.lastError = err instanceof Error ? err.message : String(err);
      log.warn(
        `Snapshot failed (${this.lastError}); consecutivePushFailures=${this.consecutivePushFailures}, ` +
          `next attempt in ~${Math.round((this.pushBackoffUntil - Date.now()) / 1000)}s`,
      );
      this.scheduleRetryAfterBackoff();
      this.onStatusChange?.();
      return 'failed';
    } finally {
      await fsp.unlink(SNAPSHOT_TAR).catch(() => {});
    }
  }

  /**
   * One line, once per box: how much of home the archive left behind.
   *
   * The archive's own size is already logged, so the missing half of the picture is what was skipped
   * — the number that says whether SNAPSHOT_EXCLUDES is still carrying its weight on real apps, and
   * whether whatever remains is worth a second look. Measured on the excluded paths directly rather
   * than through `du --exclude`, so the figure doesn't depend on du's pattern semantics matching
   * tar's.
   *
   * Detached and swallowed: this walks the largest tree on the box, so it must never be on the path
   * of a snapshot, least of all the shutdown flush. Once per box because that is enough to learn
   * from and the walk isn't free.
   */
  private logCompositionOnce(): void {
    if (this.loggedComposition) {
      return;
    }
    this.loggedComposition = true;
    void (async () => {
      try {
        const { stdout: found } = await run('find', [
          this.homeDir,
          '-name',
          'node_modules',
          '-prune',
          '-print',
        ]);
        const paths = [
          ...SNAPSHOT_EXCLUDES.anchored.map((p) =>
            path.join(this.homeDir, p.slice(2)),
          ),
          ...found.split('\n').filter(Boolean),
        ];
        const present = paths.filter((p) => fs.existsSync(p));
        if (present.length === 0) {
          log.info('Snapshot composition: nothing excluded');
          return;
        }
        const { stdout } = await run('du', ['-sk', ...present]);
        const rows = stdout
          .split('\n')
          .map((line) => line.split('\t'))
          .filter((parts) => parts.length === 2)
          .map(([kb, p]) => ({ bytes: Number(kb) * 1024, path: p }))
          .sort((a, b) => b.bytes - a.bytes);
        const total = rows.reduce((sum, r) => sum + r.bytes, 0);
        const detail = rows
          .map((r) => `${path.relative(this.homeDir, r.path)} ${mib(r.bytes)}`)
          .join(', ');
        log.info(`Snapshot composition: skipped ${mib(total)} — ${detail}`);
      } catch (err) {
        log.debug(`Composition probe failed: ${err}`);
      }
    })();
  }

  private async changedSinceMarker(): Promise<boolean> {
    if (!fs.existsSync(CHANGE_MARKER)) {
      return true;
    }
    // Prunes SNAPSHOT_EXCLUDES, because "did anything change" has to mean "did anything change that
    // we would store". An `npm install` rewrites 50,000 files under node_modules and none of them
    // are in the archive: without the prune every install schedules a snapshot of nothing. It also
    // stops the walk descending into the largest tree on the box for a question it can't answer.
    //
    // `-print -quit` stops at the first hit, so a quiet tree costs one walk of stats and a busy one
    // costs almost nothing.
    const prunes = [
      // `./.npm` → `<home>/.npm`, matching the absolute paths `find` walks and prints.
      ...SNAPSHOT_EXCLUDES.anchored.flatMap((p) => [
        '-path',
        path.join(this.homeDir, p.slice(2)),
        '-prune',
        '-o',
      ]),
      ...SNAPSHOT_EXCLUDES.anywhere.flatMap((p) => [
        '-name',
        p,
        '-prune',
        '-o',
      ]),
    ];
    const { stdout } = await run('find', [
      this.homeDir,
      ...prunes,
      '-newer',
      CHANGE_MARKER,
      '-print',
      '-quit',
    ]);
    return stdout.trim().length > 0;
  }

  private async touchMarker(): Promise<void> {
    await fsp.writeFile(CHANGE_MARKER, String(Date.now()));
  }

  private async tarHome(): Promise<{ bytes: number; sha256: string }> {
    await fsp.unlink(SNAPSHOT_TAR).catch(() => {});
    // A live box writes while we read; GNU tar exits 1 for "file changed as
    // we read it", which is expected here and not a failure.
    const { stderr } = await run(
      'tar',
      [
        // `--totals` writes `Total bytes written: N` to stderr when the archive is finished. That
        // figure is the next boot's progress denominator: it is the uncompressed size, which the
        // object itself cannot report (a streamed zstd frame carries no decompressed size) and
        // which nothing else here computes. Costs nothing — tar is already counting.
        '--totals',
        '--blocking-factor',
        String(TAR_BLOCKING_FACTOR),
        // `zstd -T0` (every core) rather than tar's own `--zstd`, which is single-threaded.
        //
        // This is a DATA-LOSS budget, not a latency one. On the shutdown path the whole cycle has
        // to finish inside SHUTDOWN_SNAPSHOT_BUDGET_MS (75s) before CFES's 90s pod grace turns
        // into a SIGKILL, and losing that race means the user loses the session's work. Kept even
        // though SNAPSHOT_EXCLUDES took the typical archive down to single-digit MB: what remains
        // is the user's own material, which is the part with no ceiling — a repo full of committed
        // assets is one commit away — and 4 cores make this ~3-4x for free.
        //
        // Same compression level, so the tar is the same size and the restore is unaffected: the
        // output is an ordinary zstd stream that `tar --zstd -xf` reads. Decompression is NOT
        // sped up by this — a single frame decodes on one core either way.
        '--use-compress-program=zstd -T0',
        ...TAR_EXCLUDE_ARGS,
        '--warning=no-file-changed',
        '-cf',
        SNAPSHOT_TAR,
        '-C',
        this.homeDir,
        '.',
      ],
      { okExitCodes: [0, 1], timeoutMs: TRANSFER_TIMEOUT_MS },
    );
    this.lastUncompressedBytes = parseTarTotalBytes(stderr);
    const [stat, sha256] = await Promise.all([
      fsp.stat(SNAPSHOT_TAR),
      sha256File(SNAPSHOT_TAR),
    ]);
    return { bytes: stat.size, sha256 };
  }

  private async uploadUsageLedgerIfChanged(uploadUrl: string): Promise<void> {
    const ledgerPath = path.join(this.workspaceDir, '.logs', 'usage.ndjson');
    let stat: fs.Stats;
    try {
      stat = await fsp.stat(ledgerPath);
    } catch {
      return;
    }
    const stamp = `${stat.size}:${stat.mtimeMs}`;
    if (stamp === this.lastLedgerStamp) {
      return;
    }
    await putFile(uploadUrl, ledgerPath, 'application/x-ndjson');
    this.lastLedgerStamp = stamp;
  }

  /** The manifest's display fields, or null when it is missing or unparsable
   * (the platform then leaves the draft metadata as it was). */
  private async readManifestFields(): Promise<Record<string, unknown> | null> {
    try {
      const raw = await fsp.readFile(
        path.join(this.workspaceDir, 'mindstudio.json'),
        'utf-8',
      );
      const mf = JSON.parse(raw);
      return {
        name: mf.name ?? null,
        description: mf.description ?? null,
        iconUrl: mf.iconUrl ?? null,
        openGraphShareImageUrl: mf.openGraphShareImageUrl ?? null,
      };
    } catch {
      return null;
    }
  }

  /** The presentation sources when they differ from the last commit that
   * carried them; null when unchanged or too large to send. */
  private async presentationIfChanged(): Promise<{
    sources: Record<string, string | null>;
    hash: string;
  } | null> {
    const paths = [...PRESENTATION_FIXED_PATHS];
    try {
      const entries = await fsp.readdir(
        path.join(this.workspaceDir, 'src', 'roadmap'),
      );
      for (const name of entries) {
        if (name.endsWith('.md')) {
          paths.push(`src/roadmap/${name}`);
        }
      }
    } catch {
      // No roadmap directory.
    }

    const sources: Record<string, string | null> = {};
    const hash = createHash('sha256');
    let totalBytes = 0;
    for (const rel of paths) {
      let content: string | null = null;
      try {
        content = await fsp.readFile(
          path.join(this.workspaceDir, rel),
          'utf-8',
        );
      } catch {
        // Absent — sent as null so the platform removes a stale artifact.
      }
      sources[rel] = content;
      hash.update(rel).update('\0');
      if (content !== null) {
        hash.update(content);
        totalBytes += Buffer.byteLength(content);
      }
      hash.update('\0');
    }
    const digest = hash.digest('hex');
    if (digest === this.lastPresentationHash) {
      return null;
    }
    if (totalBytes > PRESENTATION_MAX_BYTES) {
      log.warn(
        `Presentation sources are ${(totalBytes / 1024 / 1024).toFixed(1)} MiB; not sending (limit ${PRESENTATION_MAX_BYTES / 1024 / 1024} MiB)`,
      );
      return null;
    }
    return { sources, hash: digest };
  }

  // ---------------------------------------------------------------------------
  // Restore
  // ---------------------------------------------------------------------------

  /**
   * Rebuild home from the app's current snapshot, if there is one. See
   * `RestoreResult` for the four outcomes and what the caller owes each.
   */
  async prepareHome(): Promise<RestoreResult> {
    if (fs.existsSync(BOOTED_MARKER)) {
      log.info(
        'Booted marker present — in-place restart, resuming local state without a restore',
      );
      this.lastRestoreOutcome = 'resumed';
      return 'resumed';
    }

    const fetched = await this.fetchCurrentWithRetry();
    if (fetched === 'error') {
      this.lastRestoreOutcome = 'unresolvable';
      return 'unresolvable';
    }
    if (fetched === null) {
      log.info('No workspace snapshot for this app');
      this.lastError = null;
      this.lastRestoreOutcome = 'no_snapshot';
      return 'no_snapshot';
    }

    try {
      log.info(
        `Restoring snapshot ${fetched.snapshotId.slice(0, 8)} (${fetched.bytes === null ? '?' : (fetched.bytes / 1024 / 1024).toFixed(1)} MiB)...`,
      );
      const start = Date.now();
      const emitTransfer = makeCounterEmitter('restore');
      const sha256 = await downloadFile(
        fetched.downloadUrl,
        RESTORE_TAR,
        (done, contentLength) => {
          const total = contentLength ?? fetched.bytes;
          emitTransfer(
            {
              done,
              total,
              unit: 'bytes',
              rate: done / Math.max(0.001, (Date.now() - start) / 1000),
              label: 'Downloading',
            },
            total
              ? `Downloading snapshot · ${mib(done)} of ${mib(total)}`
              : `Downloading snapshot · ${mib(done)}`,
          );
        },
      );
      if (fetched.sha256 && sha256 !== fetched.sha256) {
        throw new Error(
          `snapshot checksum mismatch (got ${sha256.slice(0, 12)}, expected ${fetched.sha256.slice(0, 12)})`,
        );
      }
      // Split so the two phases can be told apart, because the fix for a slow restore differs
      // entirely depending on which one dominates. `transfer` responds to overlapping the download
      // with the extract (pipe the response into tar) or to a node-local cache of the tar.
      // `extract` is a single-core zstd decode plus the creation of every inode in the tree, and
      // responds to NEITHER — no amount of bandwidth or parallelism reconstructs node_modules
      // faster. Measure before optimising: at 126 MiB / 6993ms we did not know the split.
      const transferMs = Date.now() - start;
      const extractStart = Date.now();
      await fsp.mkdir(this.homeDir, { recursive: true });
      // `--checkpoint` gives us a progress feed for the 16s that dominates a boot. It counts
      // RECORDS, not files, so the figure is bytes of the uncompressed archive — which is why the
      // denominator is `uncompressedBytes` from the commit rather than the object's own size.
      // `--checkpoint-action=echo` writes to stderr, which `run` streams to us line by line.
      const emitExtract = makeCounterEmitter('restore');
      const total = fetched.uncompressedBytes ?? null;
      await run(
        'tar',
        [
          '--zstd',
          '-xf',
          RESTORE_TAR,
          '-C',
          this.homeDir,
          '--blocking-factor',
          String(TAR_BLOCKING_FACTOR),
          `--checkpoint=${TAR_CHECKPOINT_RECORDS}`,
          '--checkpoint-action=echo=%u',
        ],
        {
          timeoutMs: TRANSFER_TIMEOUT_MS,
          onStderrLine: (line) => {
            const done = recordsToBytes(line);
            if (done === null) {
              return;
            }
            emitExtract(
              {
                done,
                total,
                unit: 'bytes',
                rate:
                  done / Math.max(0.001, (Date.now() - extractStart) / 1000),
                label: 'Unpacking',
              },
              total
                ? `Unpacking · ${mib(done)} of ${mib(total)}`
                : `Unpacking · ${mib(done)}`,
            );
          },
        },
      );
      const extractMs = Date.now() - extractStart;
      log.info(
        `Home restored in ${Date.now() - start}ms (transfer+verify ${transferMs}ms, extract ${extractMs}ms)`,
      );
      this.restoreSummary = `${mib(fetched.bytes ?? 0)} in ${(
        (Date.now() - start) /
        1000
      ).toFixed(1)}s`;
      this.lastError = null;
      this.lastRestoreOutcome = 'restored';
      return 'restored';
    } catch (err) {
      // Reaches the boot display as the `restore` row's subtitle, so it is sentence-cased like the
      // rest of them rather than log-cased.
      const reason = `Snapshot restore failed: ${err instanceof Error ? err.message : String(err)}`;
      log.error(reason);
      this.lastError = reason;
      this.lastRestoreOutcome = 'unresolvable';
      return 'unresolvable';
    } finally {
      await fsp.unlink(RESTORE_TAR).catch(() => {});
    }
  }

  /** The current snapshot for THIS BOX'S BRANCH, null when that branch has none
   * (clone instead), 'error' when youai-api could not be asked after retries.
   *
   * The session id is what names the branch: an app can hold a box per branch,
   * and the platform resolves ours from the session row it gave us rather than
   * from anything we could claim about our own workspace. */
  private async fetchCurrentWithRetry(): Promise<
    CurrentSnapshot | null | 'error'
  > {
    const totalAttempts = RESTORE_RETRY_BACKOFFS_MS.length + 1;
    for (let attempt = 1; attempt <= totalAttempts; attempt++) {
      try {
        const body = await this.api<{ snapshot: CurrentSnapshot | null }>(
          'GET',
          '',
          undefined,
          { sessionId: this.sessionId },
        );
        return body.snapshot;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (attempt < totalAttempts) {
          const backoffMs = RESTORE_RETRY_BACKOFFS_MS[attempt - 1];
          log.warn(
            `Could not read the current snapshot (attempt ${attempt}/${totalAttempts}, retrying in ${backoffMs}ms): ${message}`,
          );
          await sleep(backoffMs);
        } else {
          const reason = `could not read the current snapshot after ${totalAttempts} attempts: ${message}`;
          log.error(reason);
          this.lastError = reason;
        }
      }
    }
    return 'error';
  }

  // ---------------------------------------------------------------------------
  // youai-api
  // ---------------------------------------------------------------------------

  private async api<T>(
    method: 'GET' | 'POST',
    subpath: '' | '/begin' | '/commit',
    body?: unknown,
    query?: Record<string, string>,
  ): Promise<T> {
    const search = query ? `?${new URLSearchParams(query)}` : '';
    const url = `${this.apiBaseUrl}/_internal/v2/apps/${this.appId}/dev/manage/workspace-snapshot${subpath}${search}`;
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (res.status === 409) {
      throw new SupersededError();
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(
        `${method} workspace-snapshot${subpath} → ${res.status} ${text.slice(0, 200)}`,
      );
    }
    return (await res.json()) as T;
  }

  // ---------------------------------------------------------------------------
  // Backoff
  // ---------------------------------------------------------------------------

  /** Exponential in the failure count (2s, 4s, 8s, …) capped at 60s, with
   * jitter across [delay/2, delay] so many boxes backing off a shared endpoint
   * don't resynchronize into retry waves. */
  private computePushBackoffMs(): number {
    const BASE_MS = 2_000;
    const CAP_MS = 60_000;
    const exp = Math.min(
      CAP_MS,
      BASE_MS * 2 ** (this.consecutivePushFailures - 1),
    );
    return Math.round(exp / 2 + Math.random() * (exp / 2));
  }

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

  private clearRetryTimer(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function run(
  cmd: string,
  args: string[],
  opts: {
    okExitCodes?: number[];
    timeoutMs?: number;
    /**
     * Called per complete stderr line as it arrives, for tar's checkpoint feed. stderr is still
     * accumulated as well: it's what the rejection message is built from, and a progress consumer
     * must not cost us the error text when the command fails.
     */
    onStderrLine?: (line: string) => void;
  } = {},
): Promise<{ stdout: string; stderr: string }> {
  const okExitCodes = opts.okExitCodes ?? [0];
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: opts.timeoutMs ?? HTTP_TIMEOUT_MS,
    });
    let stdout = '';
    let stderr = '';
    let pending = '';
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
      if (!opts.onStderrLine) {
        return;
      }
      // Split on newlines and hold the trailing partial: a checkpoint number arriving in two
      // chunks would otherwise parse as two smaller numbers and walk the progress bar backwards.
      pending += d;
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        opts.onStderrLine(line);
      }
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (opts.onStderrLine && pending) {
        opts.onStderrLine(pending);
      }
      if (signal) {
        reject(new Error(`${cmd} killed by ${signal}`));
        return;
      }
      if (code === null || !okExitCodes.includes(code)) {
        reject(
          new Error(
            `${cmd} exited ${code}: ${stderr.trim().split('\n').slice(-3).join(' | ')}`,
          ),
        );
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(fs.createReadStream(filePath), async function* (source) {
    for await (const chunk of source) {
      hash.update(chunk as Buffer);
    }
  });
  return hash.digest('hex');
}

/**
 * PUT a file to a presigned URL, streamed with an explicit Content-Length —
 * S3 refuses chunked PUTs, which is what `fetch` would send for a stream.
 */
async function putFile(
  url: string,
  filePath: string,
  contentType: string,
): Promise<void> {
  const { size } = await fsp.stat(filePath);
  const target = new URL(url);
  const client = target.protocol === 'http:' ? http : https;
  await new Promise<void>((resolve, reject) => {
    const req = client.request(
      target,
      {
        method: 'PUT',
        headers: { 'Content-Type': contentType, 'Content-Length': size },
        timeout: TRANSFER_TIMEOUT_MS,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve();
          } else {
            reject(
              new Error(
                `PUT ${path.basename(filePath)} → ${res.statusCode} ${Buffer.concat(chunks).toString('utf-8').slice(0, 200)}`,
              ),
            );
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('upload timed out')));
    req.on('error', reject);
    fs.createReadStream(filePath).on('error', reject).pipe(req);
  });
}

/** Download a presigned URL to a file; resolves to the body's sha256. */
async function downloadFile(
  url: string,
  destPath: string,
  /** Bytes so far and the total when the response declares one. Free: every chunk already passes
   * through here to be hashed. */
  onProgress?: (done: number, total: number | null) => void,
): Promise<string> {
  const target = new URL(url);
  const client = target.protocol === 'http:' ? http : https;
  return new Promise<string>((resolve, reject) => {
    const req = client.get(target, { timeout: TRANSFER_TIMEOUT_MS }, (res) => {
      if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        reject(new Error(`GET snapshot → ${res.statusCode}`));
        return;
      }
      const declared = Number(res.headers['content-length']);
      const total = Number.isFinite(declared) && declared > 0 ? declared : null;
      const hash = createHash('sha256');
      let done = 0;
      res.on('data', (chunk) => {
        hash.update(chunk);
        done += chunk.length;
        onProgress?.(done, total);
      });
      pipeline(res, fs.createWriteStream(destPath))
        .then(() => resolve(hash.digest('hex')))
        .catch(reject);
    });
    req.on('timeout', () => req.destroy(new Error('download timed out')));
    req.on('error', reject);
  });
}
