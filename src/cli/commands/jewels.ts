import { WINDOW, type Args, type CommandSpec } from '../args.js';
import { api, apiRaw, seg } from '../api.js';
import { fatal } from '../errors.js';
import { out } from '../output.js';
import { sleep } from '../sleep.js';
import type { Handler } from '../types.js';

/**
 * Jewel runs are full agent loops: resolve --approve applies the method as
 * the reviewer, and dryrun executes the live jewel end to end — both can
 * legitimately take minutes, so they get their own request bound.
 */
const JEWEL_RUN_TIMEOUT_MS = 600_000;

export const jewelsSpecs = {
  'jewels overview': {
    usage:
      'Usage: mindstudio-prod jewels overview [--start <ISO date>] [--end <ISO date>]',
    flags: { ...WINDOW },
  },
  'jewels pairs': {
    usage:
      'Usage: mindstudio-prod jewels pairs [--method-id <id>] [--verdict agree|disagree|skip|expired] [--mode shadow|arrival|auto|approve] [--limit 50] [--cursor <token>] [--start <ISO date>] [--end <ISO date>]',
    flags: {
      'method-id': { type: 'string', param: 'methodId' },
      verdict: { type: 'string', param: 'verdict' },
      mode: { type: 'string', param: 'mode' },
      limit: { type: 'number', param: 'limit', min: 0 },
      cursor: { type: 'string', param: 'cursor' },
      ...WINDOW,
    },
  },
  'jewels pair': {
    usage: 'Usage: mindstudio-prod jewels pair <pairId>',
    positionals: [{ name: 'pairId', required: true }],
  },
  'jewels queue': {
    usage:
      'Usage: mindstudio-prod jewels queue [--method-id <id>] [--limit 50]',
    flags: {
      'method-id': { type: 'string', param: 'methodId' },
      limit: { type: 'number', param: 'limit', min: 0 },
    },
  },
  'jewels timeseries': {
    usage:
      'Usage: mindstudio-prod jewels timeseries [--method-id <id>] [--start <ISO date>] [--end <ISO date>] [--buckets 24]',
    flags: {
      'method-id': { type: 'string', param: 'methodId' },
      ...WINDOW,
      buckets: { type: 'number', param: 'buckets', min: 1 },
    },
  },
  'jewels resolve': {
    usage:
      "Usage: mindstudio-prod jewels resolve <itemId> (--approve [--input '<json>'] | --dismiss)",
    positionals: [{ name: 'itemId', required: true }],
    flags: {
      approve: { type: 'boolean' },
      dismiss: { type: 'boolean' },
      input: { type: 'string' },
    },
  },
  'jewels dryrun': {
    usage: "Usage: mindstudio-prod jewels dryrun <methodId> --subject '<json>'",
    positionals: [{ name: 'methodId', required: true }],
    flags: {
      subject: { type: 'string' },
    },
    requireAnyOf: {
      flags: ['subject'],
      message: '--subject is required.',
    },
  },
  'jewels export': {
    usage:
      'Usage: mindstudio-prod jewels export <methodId> [--file sft-train|sft-eval|preference|eval-disagreements] [--start <ISO date>] [--end <ISO date>]',
    positionals: [{ name: 'methodId', required: true }],
    flags: {
      file: { type: 'string', param: 'file' },
      ...WINDOW,
    },
  },
  'jewels train': {
    usage:
      'Usage: mindstudio-prod jewels train <methodId> [--wait]\n' +
      'Returns immediately with a run id + dataset report; poll with ' +
      "'jewels run <runId>' (live progress on the row). --wait blocks " +
      'until terminal (minutes to tens of minutes) — for humans at a ' +
      'terminal, not agents.',
    positionals: [{ name: 'methodId', required: true }],
    flags: {
      wait: { type: 'boolean' },
    },
  },
  'jewels runs': {
    usage: 'Usage: mindstudio-prod jewels runs [--method-id <id>] [--limit 20]',
    flags: {
      'method-id': { type: 'string', param: 'methodId' },
      limit: { type: 'number', param: 'limit', min: 0 },
    },
  },
  'jewels run': {
    usage: 'Usage: mindstudio-prod jewels run <runId>',
    positionals: [{ name: 'runId', required: true }],
  },
  'jewels grade': {
    usage:
      'Usage: mindstudio-prod jewels grade <runId>\n' +
      "Re-grades a completed run's held-out predictions with the jewel's " +
      'own grade function (the same grader as the pairs dashboard) and ' +
      'writes report.grading. Runs automatically on completion; this is ' +
      'the manual retry/backfill. Idempotent.',
    positionals: [{ name: 'runId', required: true }],
  },
} satisfies Record<string, CommandSpec>;

function parseJsonFlag(a: Args, flag: string): Record<string, unknown> {
  const raw = a.str(flag)!;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    fatal(`Invalid JSON for --${flag}: ${raw}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fatal(`--${flag} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

async function jewelsOverview(appId: string, a: Args) {
  out(
    await api('GET', `/_internal/v2/apps/${appId}/jewels/overview${a.query()}`),
  );
}
async function jewelsPairs(appId: string, a: Args) {
  out(await api('GET', `/_internal/v2/apps/${appId}/jewels/pairs${a.query()}`));
}
async function jewelsPair(appId: string, a: Args) {
  out(
    await api(
      'GET',
      `/_internal/v2/apps/${appId}/jewels/pairs/${seg(a.req('pairId'))}`,
    ),
  );
}
async function jewelsQueue(appId: string, a: Args) {
  out(await api('GET', `/_internal/v2/apps/${appId}/jewels/queue${a.query()}`));
}
async function jewelsTimeseries(appId: string, a: Args) {
  out(
    await api(
      'GET',
      `/_internal/v2/apps/${appId}/jewels/timeseries${a.query()}`,
    ),
  );
}
async function jewelsResolve(appId: string, a: Args) {
  const approve = a.bool('approve');
  const dismiss = a.bool('dismiss');
  if (approve === dismiss) {
    fatal('Pass exactly one of --approve or --dismiss.');
  }
  if (dismiss && a.str('input') !== undefined) {
    fatal('--input only applies to --approve.');
  }
  const body: Record<string, unknown> = {
    itemId: a.req('itemId'),
    action: approve ? 'approve' : 'dismiss',
  };
  if (a.str('input') !== undefined) {
    body.input = parseJsonFlag(a, 'input');
  }
  out(
    await api(
      'POST',
      `/_internal/v2/apps/${appId}/jewels/queue/resolve`,
      body,
      JEWEL_RUN_TIMEOUT_MS,
    ),
  );
}
async function jewelsExport(appId: string, a: Args) {
  const qs = a.queryWith({ methodId: a.req('methodId') });
  const apiPath = `/_internal/v2/apps/${appId}/jewels/export${qs}`;
  if (a.str('file')) {
    // Raw JSONL passthrough: each dataset row goes to stdout as its own line.
    await apiRaw('GET', apiPath, JEWEL_RUN_TIMEOUT_MS);
    return;
  }
  out(await api('GET', apiPath, undefined, JEWEL_RUN_TIMEOUT_MS));
}

async function jewelsDryrun(appId: string, a: Args) {
  out(
    await api(
      'POST',
      `/_internal/v2/apps/${appId}/jewels/${seg(a.req('methodId'))}/dryrun`,
      { subject: parseJsonFlag(a, 'subject') },
      JEWEL_RUN_TIMEOUT_MS,
    ),
  );
}

const TRAIN_POLL_MS = 15_000;
const TRAIN_WAIT_LIMIT_MS = 45 * 60_000;

async function jewelsTrain(appId: string, a: Args) {
  const started = await api(
    'POST',
    `/_internal/v2/apps/${appId}/jewels/train`,
    { methodId: a.req('methodId') },
    JEWEL_RUN_TIMEOUT_MS,
  );
  if (!a.bool('wait')) {
    out(started);
    return;
  }
  // Dataset report first so the wait has context, then poll to terminal.
  out({ runId: started.run?.id, summary: started.summary });
  const runId = started.run?.id;
  const deadline = Date.now() + TRAIN_WAIT_LIMIT_MS;
  // Streaming feel from a poll: the trainer heartbeats a latest-wins
  // `progress` object onto the run; print it whenever it moves.
  let lastProgress = '';
  while (Date.now() < deadline) {
    await sleep(TRAIN_POLL_MS);
    const { run } = await api(
      'GET',
      `/_internal/v2/apps/${appId}/jewels/training-runs/${seg(runId)}`,
    );
    if (run.status === 'complete' || run.status === 'failed') {
      out(run);
      if (run.status === 'failed') {
        process.exitCode = 1;
      }
      return;
    }
    const p = run.progress;
    const signature = p ? `${p.phase}|${p.step ?? ''}` : '';
    if (signature && signature !== lastProgress) {
      lastProgress = signature;
      out({ status: run.status, progress: p });
    }
  }
  fatal(
    `Timed out waiting for run ${runId} (still in flight; check 'jewels run ${runId}').`,
  );
}

async function jewelsRuns(appId: string, a: Args) {
  out(
    await api(
      'GET',
      `/_internal/v2/apps/${appId}/jewels/training-runs${a.query()}`,
    ),
  );
}

async function jewelsRunGet(appId: string, a: Args) {
  out(
    await api(
      'GET',
      `/_internal/v2/apps/${appId}/jewels/training-runs/${seg(a.req('runId'))}`,
    ),
  );
}

async function jewelsGrade(appId: string, a: Args) {
  out(
    await api(
      'POST',
      `/_internal/v2/apps/${appId}/jewels/training-runs/${seg(a.req('runId'))}/grade`,
      undefined,
      JEWEL_RUN_TIMEOUT_MS,
    ),
  );
}

export const jewelsHandlers = {
  'jewels overview': jewelsOverview,
  'jewels pairs': jewelsPairs,
  'jewels pair': jewelsPair,
  'jewels queue': jewelsQueue,
  'jewels timeseries': jewelsTimeseries,
  'jewels resolve': jewelsResolve,
  'jewels dryrun': jewelsDryrun,
  'jewels export': jewelsExport,
  'jewels train': jewelsTrain,
  'jewels runs': jewelsRuns,
  'jewels run': jewelsRunGet,
  'jewels grade': jewelsGrade,
} satisfies Record<keyof typeof jewelsSpecs, Handler>;

export const jewelsHelp = `mindstudio-prod jewels — Monitor jewel shadowing; review + approve the proposal queue.

A jewel is a method's agentic shadow companion: it proposes the same decision
a human makes, and each (human action, jewel proposal) is graded into a PAIR
with a verdict — agree, disagree, skip (the jewel abstained on a moment the
human acted on), or expired (proposed, but nobody acted within the attribution
window). Methods with autonomy 'approve' queue their proposals for a human
reviewer instead of committing.

Subcommands:
  overview     Per-method rollup: autonomy, sampleRate, pair counts by verdict,
               agreement rate, human-invocation coverage, queue depth
  pairs        List pairs (slim rows; cursor-paginated)
  pair <id>    Full pair record: proposed vs actual, reasoning, grade notes,
               plus hydrated model transcripts when the jewel attached traces
  queue        Pending approve-mode proposals awaiting review
  timeseries   Verdict counts over time (agreement trend)
  resolve      Approve or dismiss one queue item AS the calling user
  dryrun       Run the LIVE jewel against a subject; report what it would
               propose without recording or committing anything
  export       The pair ledger as training data: a dataset report (counts,
               exclusions, trace coverage), or one file streamed as JSONL
  train        Train a private model on the method's graded pairs: exports the
               dataset, runs LoRA fine-tuning on platform GPUs, returns an
               adapter + a held-out agreement report
  runs         List training runs; run <id> shows one run + its report
  grade <id>   Re-grade a run's predictions with the jewel's own grader

The latest complete run per method is auto-served on the platform's GPU pool
as an ordinary model id (tuned/{appId}/{methodId}) — test it with a normal
generate-text call, not a jewels subcommand.

Usage:
  mindstudio-prod jewels overview [--start <ISO date>] [--end <ISO date>]
  mindstudio-prod jewels pairs [--method-id <id>] [--verdict agree|disagree|skip|expired] [--mode shadow|arrival|auto|approve] [--limit 50] [--cursor <token>]
  mindstudio-prod jewels pair <pairId>
  mindstudio-prod jewels queue [--method-id <id>] [--limit 50]
  mindstudio-prod jewels timeseries [--method-id <id>] [--buckets 24]
  mindstudio-prod jewels resolve <itemId> (--approve [--input '<json>'] | --dismiss)
  mindstudio-prod jewels dryrun <methodId> --subject '<json>'
  mindstudio-prod jewels export <methodId> [--file sft-train|sft-eval|preference|eval-disagreements]
  mindstudio-prod jewels train <methodId> [--wait]
  mindstudio-prod jewels runs [--method-id <id>]
  mindstudio-prod jewels run <runId>

Examples:
  mindstudio-prod jewels overview
  mindstudio-prod jewels pairs --method-id triage-issue --verdict disagree
  mindstudio-prod jewels pair 6f1e...
  mindstudio-prod jewels queue
  mindstudio-prod jewels resolve 6f1e... --approve
  mindstudio-prod jewels resolve 6f1e... --approve --input '{"issueId":"abc","severity":"high"}'
  mindstudio-prod jewels resolve 6f1e... --dismiss
  mindstudio-prod jewels dryrun triage-issue --subject '{"issueId":"abc"}'
  mindstudio-prod jewels export triage-issue
  mindstudio-prod jewels export triage-issue --file sft-train > train.jsonl
  mindstudio-prod jewels train triage-issue --wait
  mindstudio-prod jewels run 6f1e...

Notes:
  - 'resolve --approve' APPLIES the method as you (the reviewer): the proposal's
    input runs for real, the platform grades proposed-vs-final, and the item
    closes. Pass --input to apply an edited version (recorded as resolution
    'edited'). --dismiss closes the item without acting.
  - 'dryrun' runs against production data inside a disposable database mirror,
    so it is guaranteed side-effect-free on the app database. It is the prod
    twin of the dev testJewel tool (which runs draft code against the dev DB).
  - approve/dryrun hold the request for a full jewel/method run — allow minutes.
  - 'train' uses the method's manifest tuning dial from the LIVE release and
    trains on graded pairs with attached traces (the dataset report names what
    was excluded and why). The report's agreement is against the held-out
    ledger split — real decisions the model never saw. One run per method at a
    time. The trained model is an artifact + report for now; serving it is a
    later phase.
  - Time window defaults to the last 30 days when --start/--end are omitted.`;
