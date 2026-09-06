/**
 * Workspace snapshots: the box's home directory, tarred whole, in S3.
 *
 * `/home/remy` is the user's computer and the image is the platform's, so the
 * snapshot is that directory with no knowledge of what is in it — workspace,
 * node_modules, .git, global npm installs, dotfiles, caches. Restore is untar
 * and go. What the platform needs to know about the contents (the manifest's
 * display fields, the presentation sources, the usage ledger) is sent with
 * each commit rather than read out of the blob.
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

const log = createLogger('snapshot');

const SNAPSHOT_INTERVAL_MS = 5 * 60_000;
// Outside home so it is never inside the tar, and inside the container's own
// filesystem so it survives an in-place server restart but not a new pod.
const CHANGE_MARKER = '/tmp/.snapshot-marker';
const BOOTED_MARKER = '/tmp/.cnc-booted';
const SNAPSHOT_TAR = '/tmp/snapshot.tar.zst';
const RESTORE_TAR = '/tmp/restore.tar.zst';
const RESTORE_RETRY_BACKOFFS_MS = [2_000, 6_000, 18_000];
const HTTP_TIMEOUT_MS = 30_000;
const TRANSFER_TIMEOUT_MS = 10 * 60_000;

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
 * - `fenced`: a newer session has committed a snapshot, so this box must never write again.
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
  /** Fired on health transitions (failing / recovered / fenced) so the C&C
   * server can broadcast fresh status to editor clients. */
  onStatusChange?: () => void;
}

interface CurrentSnapshot {
  snapshotId: string;
  bytes: number | null;
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
  /** Permanently disabled: youai-api answered 409, so a newer session owns the
   * app. A fenced box must never write again. */
  private fenced = false;
  /** Content hash of the presentation sources at the last commit that carried
   * them; they are re-sent only when it changes. */
  private lastPresentationHash: string | null = null;
  /** size:mtime of the usage ledger at its last upload. */
  private lastLedgerStamp: string | null = null;

  constructor(opts: HomeSnapshotManagerOptions) {
    this.homeDir = opts.homeDir;
    this.workspaceDir = opts.workspaceDir;
    this.appId = opts.appId;
    this.sessionId = opts.sessionId;
    this.apiBaseUrl = opts.apiBaseUrl.replace(/\/$/, '');
    this.apiKey = opts.apiKey;
    this.onStatusChange = opts.onStatusChange ?? null;
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
      fenced: this.fenced,
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
    if (this.fenced) {
      log.debug('Fenced by a newer session; refusing to snapshot');
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
    if (this.fenced) {
      log.warn('Fenced by a newer session; refusing to flush');
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
      }>('POST', '/begin', { sessionId: this.sessionId });

      await putFile(begun.uploadUrl, SNAPSHOT_TAR, 'application/zstd');
      await this.uploadUsageLedgerIfChanged(begun.usageLedgerUploadUrl);

      const presentation = await this.presentationIfChanged();
      await this.api('POST', '/commit', {
        snapshotId: begun.snapshotId,
        sessionId: this.sessionId,
        bytes,
        sha256,
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
        log.error(
          `Superseded by a newer sandbox session for ${this.appId}; fencing all future snapshots`,
        );
        this.fenced = true;
        this.lastError = err.message;
        this.stop();
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

  private async changedSinceMarker(): Promise<boolean> {
    if (!fs.existsSync(CHANGE_MARKER)) {
      return true;
    }
    // `-print -quit` stops at the first hit, so a quiet tree costs one walk of
    // stats and a busy one costs almost nothing.
    const { stdout } = await run('find', [
      this.homeDir,
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
    await run(
      'tar',
      [
        // `zstd -T0` (every core) rather than tar's own `--zstd`, which is single-threaded.
        //
        // This is a DATA-LOSS budget, not a latency one. On the shutdown path the whole cycle has
        // to finish inside SHUTDOWN_SNAPSHOT_BUDGET_MS (75s) before CFES's 90s pod grace turns
        // into a SIGKILL, and single-threaded zstd measured ~29 MB/s: fine for the 392 MiB home
        // we first saw, ~70s of tarring alone at 2 GB, and homes only grow — the boundary
        // deliberately includes node_modules, .git, ~/.npm-global and every cache. Losing the
        // race means the user loses the session's work, and it arrives as a function of how long
        // they have been building. A dev box has 4 cores, so this is ~3-4x for free.
        //
        // Same compression level, so the tar is the same size and the restore is unaffected: the
        // output is an ordinary zstd stream that `tar --zstd -xf` reads. Decompression is NOT
        // sped up by this — a single frame decodes on one core either way.
        '--use-compress-program=zstd -T0',
        '--warning=no-file-changed',
        '-cf',
        SNAPSHOT_TAR,
        '-C',
        this.homeDir,
        '.',
      ],
      { okExitCodes: [0, 1], timeoutMs: TRANSFER_TIMEOUT_MS },
    );
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
      const sha256 = await downloadFile(fetched.downloadUrl, RESTORE_TAR);
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
      await run('tar', ['--zstd', '-xf', RESTORE_TAR, '-C', this.homeDir], {
        timeoutMs: TRANSFER_TIMEOUT_MS,
      });
      const extractMs = Date.now() - extractStart;
      log.info(
        `Home restored in ${Date.now() - start}ms (transfer+verify ${transferMs}ms, extract ${extractMs}ms)`,
      );
      this.lastError = null;
      this.lastRestoreOutcome = 'restored';
      return 'restored';
    } catch (err) {
      const reason = `snapshot restore failed: ${err instanceof Error ? err.message : String(err)}`;
      log.error(reason);
      this.lastError = reason;
      this.lastRestoreOutcome = 'unresolvable';
      return 'unresolvable';
    } finally {
      await fsp.unlink(RESTORE_TAR).catch(() => {});
    }
  }

  /** The current snapshot, null when the app has none, 'error' when youai-api
   * could not be asked after retries. */
  private async fetchCurrentWithRetry(): Promise<
    CurrentSnapshot | null | 'error'
  > {
    const totalAttempts = RESTORE_RETRY_BACKOFFS_MS.length + 1;
    for (let attempt = 1; attempt <= totalAttempts; attempt++) {
      try {
        const body = await this.api<{ snapshot: CurrentSnapshot | null }>(
          'GET',
          '',
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
  ): Promise<T> {
    const url = `${this.apiBaseUrl}/_internal/v2/apps/${this.appId}/dev/manage/workspace-snapshot${subpath}`;
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
  opts: { okExitCodes?: number[]; timeoutMs?: number } = {},
): Promise<{ stdout: string }> {
  const okExitCodes = opts.okExitCodes ?? [0];
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: opts.timeoutMs ?? HTTP_TIMEOUT_MS,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
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
      resolve({ stdout });
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
async function downloadFile(url: string, destPath: string): Promise<string> {
  const target = new URL(url);
  const client = target.protocol === 'http:' ? http : https;
  return new Promise<string>((resolve, reject) => {
    const req = client.get(target, { timeout: TRANSFER_TIMEOUT_MS }, (res) => {
      if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        reject(new Error(`GET snapshot → ${res.statusCode}`));
        return;
      }
      const hash = createHash('sha256');
      res.on('data', (chunk) => hash.update(chunk));
      pipeline(res, fs.createWriteStream(destPath))
        .then(() => resolve(hash.digest('hex')))
        .catch(reject);
    });
    req.on('timeout', () => req.destroy(new Error('download timed out')));
    req.on('error', reject);
  });
}
