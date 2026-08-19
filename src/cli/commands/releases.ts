import { execFileSync } from 'node:child_process';
import { type Args, type CommandSpec } from '../args.js';
import { api, apiTry, seg } from '../api.js';
import { WORKSPACE_DIR } from '../config.js';
import { EXIT, fatal } from '../errors.js';
import { out, progress } from '../output.js';
import { sleep } from '../sleep.js';
import type { Handler } from '../types.js';

export const releasesSpecs = {
  'releases list': {
    usage: 'Usage: mindstudio-prod releases list [--limit 20]',
    flags: { limit: { type: 'number', param: 'limit', min: 1, max: 100 } },
  },
  'releases get': {
    usage: 'Usage: mindstudio-prod releases get <releaseId>',
    positionals: [{ name: 'releaseId', required: true }],
  },
  'releases current': {
    usage: 'Usage: mindstudio-prod releases current',
  },
  'releases status': {
    usage:
      'Usage: mindstudio-prod releases status <releaseId> [--wait] [--timeout 120]',
    positionals: [{ name: 'releaseId', required: true }],
    flags: { wait: { type: 'boolean' }, timeout: { type: 'number', min: 1 } },
  },
  'releases wait': {
    usage:
      'Usage: mindstudio-prod releases wait [--commit <sha>] [--timeout 300]',
    flags: {
      commit: { type: 'string' },
      timeout: { type: 'number', min: 1 },
    },
  },
} satisfies Record<string, CommandSpec>;

/** Current HEAD commit SHA in the workspace, or null if git isn't resolvable. */
function gitHeadSha(): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: WORKSPACE_DIR,
      encoding: 'utf-8',
    }).trim();
  } catch {
    return null;
  }
}
/**
 * Best-effort expansion of an abbreviated SHA to the full 40-hex via the
 * workspace repo. Falls back to the input untouched — the object may live
 * only on the server (e.g. a SHA copied from another clone's push output),
 * and the API accepts short SHAs by prefix, so this is an optimization for
 * exactness, not a requirement.
 */
function expandCommitSha(sha: string): string {
  if (sha.length === 40) {
    return sha;
  }
  try {
    return execFileSync('git', ['rev-parse', '--verify', `${sha}^{commit}`], {
      cwd: WORKSPACE_DIR,
      encoding: 'utf-8',
    }).trim();
  } catch {
    return sha;
  }
}
/** Print the final wait result and set the process exit code (no truncation). */
function finishWait(data: unknown, code: number): void {
  out(data);
  process.exitCode = code;
}
/**
 * Why a failed build failed.
 *
 * There is no `error` column on a release — when the API marks one failed it
 * appends a build-log entry with phase 'error' carrying the message. The
 * by-commit endpoint returns the plain release row, buildLog included, so the
 * reason is already in hand here; it just used to be dropped, forcing the caller
 * to make a second `releases get` call.
 */
function buildFailureReason(release: any): string | null {
  const log: any[] = Array.isArray(release.buildLog) ? release.buildLog : [];
  const errors = log.filter(
    (entry) => entry?.phase === 'error' && typeof entry.message === 'string',
  );
  return errors.length ? errors[errors.length - 1].message : null;
}
/** Compact, stable projection of a release for the wait result. */
function summarizeRelease(release: any) {
  const summary = {
    releaseId: release.id,
    commitSha: release.commitSha,
    branch: release.branch ?? null,
    status: release.status,
    buildDurationMs: release.buildDurationMs ?? null,
    publishedAt: release.publishedAt ?? null,
  };
  if (release.status !== 'failed') {
    return summary;
  }
  return {
    ...summary,
    error:
      buildFailureReason(release) ??
      'Build failed (no error entry in the build log)',
  };
}
async function releasesList(appId: string, a: Args) {
  // Newest-first, non-dev releases. `--limit` is honored via the paginated
  // releases endpoint (default 20, max 100) — the dashboard's release list is
  // hardcoded to 10 and ignores a limit, which is why callers that passed
  // `--limit 1` silently got the full set.
  const result = await api(
    'GET',
    `/_internal/v2/apps/${appId}/releases${a.query()}`,
  );
  out(result.releases ?? []);
}
async function releasesGet(appId: string, a: Args) {
  out(
    await api(
      'GET',
      `/_internal/v2/apps/${appId}/releases/${seg(a.req('releaseId'))}`,
    ),
  );
}
async function releasesCurrent(appId: string) {
  const dashboard = await api('GET', `/_internal/v2/apps/${appId}/dashboard`);
  if (!dashboard.liveRelease) {
    fatal('No live release — publish first.');
  }
  out(dashboard.liveRelease);
}
async function releasesStatus(appId: string, a: Args) {
  const releaseId = a.req('releaseId');
  const wait = a.bool('wait');
  const timeout = (a.num('timeout') ?? 120) * 1000;
  const startTime = Date.now();

  // Terminal statuses — anything that isn't actively building/compiling
  const TERMINAL = new Set([
    'live',
    'compiled',
    'preview',
    'failed',
    'superseded',
  ]);

  if (!wait) {
    const release = await api(
      'GET',
      `/_internal/v2/apps/${appId}/releases/${seg(releaseId)}`,
    );
    out(release);
    return;
  }

  // Poll silently, only print the final result
  while (true) {
    const release = await api(
      'GET',
      `/_internal/v2/apps/${appId}/releases/${seg(releaseId)}`,
    );

    if (TERMINAL.has(release.status)) {
      out(release);
      return;
    }

    if (Date.now() - startTime > timeout) {
      fatal(`Timed out waiting for release ${releaseId} (${timeout / 1000}s)`);
    }

    await sleep(3000);
  }
}
/**
 * Wait for the release built from a git commit to reach a terminal state.
 *
 * This is the "publish and wait until live" primitive: after `git push`, a
 * caller has a commit SHA (not a release id), so we resolve the release by
 * commit, then poll until it goes live / fails / times out — reporting the
 * verdict via the exit code so the caller never has to scrape output.
 *
 * `--commit` defaults to the workspace's HEAD. Success is `live` (default
 * branch) or `preview` (feature branch); `failed`/`superseded` and timeout
 * each get their own exit code.
 */
async function releasesWait(appId: string, a: Args) {
  const rawCommit = a.str('commit') ?? gitHeadSha();
  if (!rawCommit) {
    fatal(
      'Could not determine commit SHA — pass --commit <sha> or run inside the app git repo',
    );
  }
  // Fail fast on a non-SHA instead of burning the 30s resolve window on a
  // value the API would never match (it 400s on non-hex anyway).
  if (!/^[0-9a-f]{7,40}$/i.test(rawCommit)) {
    fatal(
      `--commit must be a 7-40 character hex commit SHA (got ${JSON.stringify(rawCommit)})`,
    );
  }
  const commit = expandCommitSha(rawCommit);
  const timeoutMs = (a.num('timeout') ?? 300) * 1000;
  const POLL_MS = 3000;
  // A push returns before the receive-pack hook necessarily finishes inserting
  // the release row, so tolerate 404s for a short grace window while resolving.
  const RESOLVE_GRACE_MS = 30_000;
  const shortSha = commit.slice(0, 8);
  const releasePath = `/_internal/v2/apps/${appId}/releases/by-commit/${seg(commit)}`;
  const start = Date.now();

  // Phase 1 — resolve the release for this commit.
  let release: any = null;
  while (true) {
    const r = await apiTry('GET', releasePath);
    if (r.ok) {
      release = r.body;
      break;
    }
    if (r.status !== 404) {
      fatal(
        `Failed to resolve release for ${shortSha}: HTTP ${r.status} ${JSON.stringify(r.body)}`,
      );
    }
    if (Date.now() - start > RESOLVE_GRACE_MS) {
      finishWait(
        {
          status: 'not_found',
          commitSha: commit,
          error: `No release created for commit ${commit} within ${RESOLVE_GRACE_MS / 1000}s — either the push hasn't registered yet or this SHA never produced a build`,
        },
        EXIT.notFound,
      );
      return;
    }
    progress(`waiting for release to be created for ${shortSha}…`);
    await sleep(POLL_MS);
  }

  // Phase 2 — poll status until terminal.
  const SUCCESS = new Set(['live', 'preview']);
  while (true) {
    if (SUCCESS.has(release.status)) {
      finishWait(summarizeRelease(release), EXIT.ok);
      return;
    }
    if (release.status === 'failed') {
      finishWait(summarizeRelease(release), EXIT.buildFailed);
      return;
    }
    if (release.status === 'superseded') {
      finishWait(summarizeRelease(release), EXIT.superseded);
      return;
    }
    if (Date.now() - start > timeoutMs) {
      finishWait(
        {
          ...summarizeRelease(release),
          error: `Timed out after ${timeoutMs / 1000}s (last status: ${release.status})`,
        },
        EXIT.timeout,
      );
      return;
    }
    progress(
      `${release.status}… (${Math.round((Date.now() - start) / 1000)}s)`,
    );
    await sleep(POLL_MS);
    const r = await apiTry('GET', releasePath);
    if (r.ok) {
      release = r.body;
    }
    // A transient non-ok keeps the last known release; the timeout guard above
    // still applies, so we don't loop forever on a persistent error.
  }
}

export const releasesHandlers = {
  'releases list': releasesList,
  'releases get': releasesGet,
  'releases current': releasesCurrent,
  'releases status': releasesStatus,
  'releases wait': releasesWait,
} satisfies Record<keyof typeof releasesSpecs, Handler>;

export const releasesHelp = `mindstudio-prod releases — View and monitor releases.

Subcommands:
  list      List releases, newest first (--limit N, default 20, max 100)
  get       Get full details of a specific release
  current   Get the currently live release
  status    Check a release's status by id (optionally poll until complete)
  wait      Wait for the release built from a commit to go live

Usage:
  mindstudio-prod releases list [--limit 20]
  mindstudio-prod releases get <releaseId>
  mindstudio-prod releases current
  mindstudio-prod releases status <releaseId> [--wait] [--timeout 120]
  mindstudio-prod releases wait [--commit <sha>] [--timeout 300]

'releases wait' is the "publish and wait until live" primitive. After a
'git push', run it to block until the pushed commit's release is terminal.
--commit defaults to the workspace HEAD; abbreviated SHAs (7+ hex chars,
e.g. from push output) are accepted. It prints one JSON object and sets
the exit code so you can branch on $? without parsing:
  0  live (deployed)        2  timed out (still building)   4  superseded
  1  build failed           3  no release found for commit
Any other failure (bad arguments, auth, API error) exits 10, so exit 1 always
means the build itself failed.

Examples:
  git push origin HEAD && mindstudio-prod releases wait
  mindstudio-prod releases wait --commit 91ca67a --timeout 600
  mindstudio-prod releases list --limit 1`;
