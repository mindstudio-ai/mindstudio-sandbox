import { WINDOW, type Args, type CommandSpec } from '../args.js';
import { api, seg } from '../api.js';
import { fatal } from '../errors.js';
import { out } from '../output.js';
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

export const jewelsHandlers = {
  'jewels overview': jewelsOverview,
  'jewels pairs': jewelsPairs,
  'jewels pair': jewelsPair,
  'jewels queue': jewelsQueue,
  'jewels timeseries': jewelsTimeseries,
  'jewels resolve': jewelsResolve,
  'jewels dryrun': jewelsDryrun,
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
  pair <id>    Full pair record: proposed vs actual, reasoning, grade notes
  queue        Pending approve-mode proposals awaiting review
  timeseries   Verdict counts over time (agreement trend)
  resolve      Approve or dismiss one queue item AS the calling user
  dryrun       Run the LIVE jewel against a subject; report what it would
               propose without recording or committing anything

Usage:
  mindstudio-prod jewels overview [--start <ISO date>] [--end <ISO date>]
  mindstudio-prod jewels pairs [--method-id <id>] [--verdict agree|disagree|skip|expired] [--mode shadow|arrival|auto|approve] [--limit 50] [--cursor <token>]
  mindstudio-prod jewels pair <pairId>
  mindstudio-prod jewels queue [--method-id <id>] [--limit 50]
  mindstudio-prod jewels timeseries [--method-id <id>] [--buckets 24]
  mindstudio-prod jewels resolve <itemId> (--approve [--input '<json>'] | --dismiss)
  mindstudio-prod jewels dryrun <methodId> --subject '<json>'

Examples:
  mindstudio-prod jewels overview
  mindstudio-prod jewels pairs --method-id triage-issue --verdict disagree
  mindstudio-prod jewels pair 6f1e...
  mindstudio-prod jewels queue
  mindstudio-prod jewels resolve 6f1e... --approve
  mindstudio-prod jewels resolve 6f1e... --approve --input '{"issueId":"abc","severity":"high"}'
  mindstudio-prod jewels resolve 6f1e... --dismiss
  mindstudio-prod jewels dryrun triage-issue --subject '{"issueId":"abc"}'

Notes:
  - 'resolve --approve' APPLIES the method as you (the reviewer): the proposal's
    input runs for real, the platform grades proposed-vs-final, and the item
    closes. Pass --input to apply an edited version (recorded as resolution
    'edited'). --dismiss closes the item without acting.
  - 'dryrun' runs against production data inside a disposable database mirror,
    so it is guaranteed side-effect-free on the app database. It is the prod
    twin of the dev testJewel tool (which runs draft code against the dev DB).
  - approve/dryrun hold the request for a full jewel/method run — allow minutes.
  - Time window defaults to the last 30 days when --start/--end are omitted.`;
