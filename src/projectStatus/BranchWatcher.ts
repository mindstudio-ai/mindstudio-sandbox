/**
 * Which branch this box is on, and telling the platform when it changes.
 *
 * The platform picks a branch at boot and the clone honours it, but from then on the WORKING TREE
 * is the truth: the user can `git checkout` in the terminal, the agent does it unprompted mid-task,
 * and the picker's "switch branch" is nothing more than a request for this box to run a checkout.
 * A platform that only remembered what it asked for at boot would preview one branch while methods
 * executed against another's dev release, and would file the next workspace snapshot under a branch
 * that is no longer checked out — which is somebody's work going missing, silently.
 *
 * So there is one source of truth (HEAD) and two ways of noticing it moved:
 *
 *   the hook   `.git/hooks/post-checkout`, installed by bootstrap, curls this box's own
 *              `/internal/head-changed`. Sub-second, and it covers `checkout` and `switch`, which is
 *              how a branch changes almost every time.
 *   the tick   a HEAD read on an interval. This is the one that makes the design honest: a hook does
 *              not fire for a branch rename or a bare `symbolic-ref`, a snapshot restore can bring
 *              back a `.git` whose hooks predate ours, and a report can simply have failed. Nothing
 *              relies on the hook being present or having worked.
 *
 * Reports are idempotent and the platform ignores one that matches what it already has, so the tick
 * is cheap to run often and the two paths never need to coordinate.
 */

import { execFile } from 'node:child_process';
import { createLogger } from '../logger.js';

const log = createLogger('branch');

/**
 * How often HEAD is re-read as the backstop.
 *
 * Well under the snapshot interval, because the thing it protects against is a snapshot being filed
 * under a stale branch — so the reconciliation has to be faster than the writer it is guarding.
 */
const POLL_INTERVAL_MS = 20_000;

export interface BranchWatcherOpts {
  workspaceDir: string;
  appId: string;
  sessionId: string;
  apiKey: string;
  apiBaseUrl: string;
  /** The branch the platform told us to start on, so the first report has something to compare. */
  initialBranch: string;
  /** This session's own token, which is how a report proves it comes from this box. */
  sandboxToken: string;
  /**
   * Fired when HEAD lands somewhere new, so editor clients hear about it over the C&C socket rather
   * than finding out on their next reconnect.
   *
   * Needed because a checkout is not always something the editor asked for: the agent switches
   * branches mid-task, and a user can do it in the terminal. Same shape as the snapshot manager's
   * `onStatusChange` for the same reason.
   */
  onChange?: (branch: string) => void;
}

/** `git rev-parse --abbrev-ref HEAD`, or null when git could not answer. */
function readHead(workspaceDir: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      { cwd: workspaceDir, encoding: 'utf-8', timeout: 10_000 },
      (err, stdout) => {
        if (err) {
          resolve(null);
          return;
        }
        const value = stdout.trim();
        resolve(value.length > 0 ? value : null);
      },
    );
  });
}

export class BranchWatcher {
  private readonly opts: BranchWatcherOpts;
  /**
   * What HEAD actually said, at the last read. Two fields rather than one, because they answer
   * different questions and conflating them files snapshots under the wrong branch: a report that
   * fails rolls `reported` back, and if `current` were that same field the next snapshot would be
   * filed against the branch the box has just LEFT — where nothing looks for it.
   */
  private head: string | null;
  /** The last value the platform acknowledged, so a no-change tick costs one git fork and no POST. */
  private reported: string | null;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Serialises reconciliation — see `again`, which is what keeps it from dropping observations. */
  private inFlight: Promise<void> | null = null;
  /**
   * Set when something asks to reconcile while a reconcile is running, so the run repeats instead of
   * the caller silently joining a read that happened BEFORE the change it is reporting. That drop is
   * how a checkout could complete and be answered with the branch the box was on a moment earlier.
   */
  private again = false;

  constructor(opts: BranchWatcherOpts) {
    this.opts = opts;
    this.head = opts.initialBranch || null;
    this.reported = opts.initialBranch || null;
  }

  /** What HEAD is, which is the branch a snapshot taken now belongs to. */
  get current(): string | null {
    return this.head;
  }

  start(): void {
    if (this.timer) {
      return;
    }
    // Report once at boot even when it matches what we were told: it is what closes the case where
    // a restored snapshot came back on a different branch than the session row records.
    void this.reconcile({ force: true });
    this.timer = setInterval(() => void this.reconcile(), POLL_INTERVAL_MS);
    // Never hold the process open on account of a poll.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** The hook's entry point: HEAD just moved, look now rather than at the next tick. */
  poke(): Promise<void> {
    return this.reconcile();
  }

  /**
   * Check a branch out, then report where we landed.
   *
   * `checkout -b` when the branch does not exist yet, which is how a branch created in the picker
   * comes into being: locally first, then on the remote at its first push, where `postReceive` mints
   * its preview release like any other branch.
   *
   * Reports even on failure, because a failed checkout leaves the box somewhere and that somewhere
   * is what the platform needs to know.
   */
  async checkout(
    branch: string,
  ): Promise<{ ok: boolean; branch: string | null; error: string | null }> {
    const { workspaceDir } = this.opts;
    const exists = await this.branchExists(branch);
    const args = exists ? ['checkout', branch] : ['checkout', '-b', branch];
    log.info(
      `${exists ? 'Checking out' : 'Creating'} ${branch}${exists ? '' : ' (new local branch)'}`,
    );

    const error = await new Promise<string | null>((resolve) => {
      execFile(
        'git',
        args,
        { cwd: workspaceDir, encoding: 'utf-8', timeout: 60_000 },
        (err, _stdout, stderr) => {
          resolve(err ? stderr?.trim() || (err as Error).message : null);
        },
      );
    });

    await this.reconcile({ force: true });
    if (error) {
      log.warn(`Checkout of ${branch} failed: ${error}`);
    }
    return { ok: !error, branch: this.reported, error };
  }

  private branchExists(branch: string): Promise<boolean> {
    return new Promise((resolve) => {
      execFile(
        'git',
        ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`],
        { cwd: this.opts.workspaceDir, timeout: 10_000 },
        (err) => resolve(!err),
      );
    });
  }

  /**
   * Read HEAD and report it when it has moved (or when `force`, which the boot report uses).
   *
   * Coalesces rather than joins. Asking while a run is in flight sets `again` and waits for a fresh
   * read afterwards — joining the in-flight promise would resolve against a HEAD read *before* the
   * change being reported, which is exactly how `checkout()` could answer with the branch the box
   * had just left and the platform could then hand that branch to the wrong box.
   */
  private reconcile(params?: { force: boolean }): Promise<void> {
    if (this.inFlight) {
      this.again = true;
      return this.inFlight.then(() =>
        this.again ? this.reconcile(params) : undefined,
      );
    }
    const run = (async () => {
      this.again = false;
      const head = await readHead(this.opts.workspaceDir);
      // A detached HEAD reads as `HEAD` and is not a branch — the box is mid-rebase or mid-bisect
      // and will land on one. Recording it would key snapshots under a name no ref can match, and
      // `head` is deliberately left alone so a snapshot mid-rebase files under the branch the box
      // was on rather than under nothing.
      if (!head || head === 'HEAD') {
        return;
      }
      // Set before the request and never rolled back: this is what HEAD says, and a snapshot taken
      // from here on belongs to this branch whether or not the platform has acknowledged it yet.
      this.head = head;
      if (head === this.reported && !params?.force) {
        return;
      }
      const previous = this.reported;
      // Recorded BEFORE the request, so a burst of hook fires during one checkout does not become a
      // burst of reports. A failed report rolls only THIS back, so the next tick sees it still
      // differs from what the platform acknowledged and tries again.
      this.reported = head;
      try {
        await this.report(head);
        if (head !== previous) {
          log.info(`Now on ${head} (was ${previous ?? 'unknown'})`);
          this.opts.onChange?.(head);
        }
      } catch (err) {
        this.reported = previous;
        log.warn(
          `Could not report branch ${head}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    })();
    this.inFlight = run.finally(() => {
      this.inFlight = null;
    });
    return this.inFlight.then(() =>
      this.again ? this.reconcile(params) : undefined,
    );
  }

  private async report(branch: string): Promise<void> {
    const { apiBaseUrl, appId, sessionId, apiKey, sandboxToken } = this.opts;
    const res = await fetch(
      `${apiBaseUrl}/_internal/v2/apps/${appId}/dev/manage/branch`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          // Proves this is the box, not merely something holding the org's API key — which every
          // box of the app and every collaborator has. Without it, one box could point another at
          // an arbitrary branch. Same secret the platform presents coming the other way to
          // `/flush` and `/switch-branch`.
          ...(sandboxToken ? { 'x-sandbox-token': sandboxToken } : {}),
        },
        body: JSON.stringify({ sessionId, branch }),
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`${res.status} ${text.slice(0, 200)}`);
    }
  }
}
