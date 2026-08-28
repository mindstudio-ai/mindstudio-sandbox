import { PAGINATION, WINDOW, type Args, type CommandSpec } from '../args.js';
import { api, seg } from '../api.js';
import { fatal } from '../errors.js';
import { out } from '../output.js';
import type { Handler } from '../types.js';

//////////////////////////////////////////////////////////////////////////////
// Outbound email: the delivery log, blast stats, and the app's unsubscribe list.
//
// Reads the same `outbound-email/*` manage endpoints the dashboard uses, so
// anything answerable in the console is answerable here. That parity is the
// point — an app owner (or the agent debugging on their behalf) should never have
// to open our UI to find out why a send didn't arrive.
//
// The log deliberately covers mail that never reached SES — unsubscribed, over
// the daily cap, sender not allowed — because that is where most real failures
// live, and a log built on delivery events alone shows nothing at all for them.
//////////////////////////////////////////////////////////////////////////////

export const emailSpecs = {
  'email list': {
    usage:
      'Usage: mindstudio-prod email list [--status <s,s>] [--kind method|auth] [--recipient <addr>] [--batch <id>] [--search <text>] [--start <ISO>] [--end <ISO>] [--limit 50]',
    flags: {
      status: { type: 'string', param: 'status' },
      kind: { type: 'string', param: 'kind' },
      recipient: { type: 'string', param: 'recipient' },
      batch: { type: 'string', param: 'batchId' },
      search: { type: 'string', param: 'search' },
      ...WINDOW,
      ...PAGINATION,
    },
  },
  'email get': {
    usage: 'Usage: mindstudio-prod email get <messageId>',
    positionals: [{ name: 'messageId', required: true }],
  },
  'email stats': {
    usage:
      'Usage: mindstudio-prod email stats [--start <ISO date>] [--end <ISO date>]',
    flags: { ...WINDOW },
  },
  'email batches': {
    usage:
      'Usage: mindstudio-prod email batches [--start <ISO date>] [--end <ISO date>] [--limit 50]',
    flags: { ...WINDOW, ...PAGINATION },
  },
  'email batch': {
    usage: 'Usage: mindstudio-prod email batch <batchId>',
    positionals: [{ name: 'batchId', required: true }],
  },
  'email suppressions': {
    usage: 'Usage: mindstudio-prod email suppressions [--limit 50]',
    flags: { ...PAGINATION },
  },
  'email suppress': {
    usage: 'Usage: mindstudio-prod email suppress <email>',
    positionals: [{ name: 'email', required: true }],
  },
  'email unsuppress': {
    usage: 'Usage: mindstudio-prod email unsuppress <email> --confirm',
    positionals: [{ name: 'email', required: true }],
    flags: { confirm: { type: 'boolean' } },
  },
} satisfies Record<string, CommandSpec>;

async function emailList(appId: string, a: Args) {
  out(
    await api(
      'GET',
      `/_internal/v2/apps/${appId}/outbound-email/messages${a.query()}`,
    ),
  );
}

async function emailGet(appId: string, a: Args) {
  out(
    await api(
      'GET',
      `/_internal/v2/apps/${appId}/outbound-email/messages/${seg(a.req('messageId'))}`,
    ),
  );
}

async function emailStats(appId: string, a: Args) {
  out(
    await api(
      'GET',
      `/_internal/v2/apps/${appId}/outbound-email/summary${a.query()}`,
    ),
  );
}

async function emailBatches(appId: string, a: Args) {
  out(
    await api(
      'GET',
      `/_internal/v2/apps/${appId}/outbound-email/batches${a.query()}`,
    ),
  );
}

async function emailBatch(appId: string, a: Args) {
  out(
    await api(
      'GET',
      `/_internal/v2/apps/${appId}/outbound-email/batches/${seg(a.req('batchId'))}`,
    ),
  );
}

async function emailSuppressions(appId: string, a: Args) {
  out(
    await api(
      'GET',
      `/_internal/v2/apps/${appId}/outbound-email/suppressions${a.query()}`,
    ),
  );
}

async function emailSuppress(appId: string, a: Args) {
  out(
    await api(
      'POST',
      `/_internal/v2/apps/${appId}/outbound-email/suppressions/add`,
      {
        email: a.req('email'),
      },
    ),
  );
}

/**
 * Resubscribe an address.
 *
 * `--confirm` is required because this is outward-facing: it causes mail to reach
 * someone who opted out. A single-address resubscribe is a legitimate, common
 * request (someone emailed support asking to be re-added) — the gate exists
 * because the agent runs this command too, and an automated opt-out reversal
 * should be a deliberate act rather than a side effect.
 *
 * The response carries `platformSuppression`. Non-null means the address is ALSO
 * on SES's account-level list after a hard bounce or complaint, which we never
 * clear (that list is account-wide, so re-sending spends sending reputation
 * shared by every tenant). Removing our row does not make that address
 * deliverable, so say so rather than printing a bare success.
 */
async function emailUnsuppress(appId: string, a: Args) {
  if (!a.bool('confirm')) {
    fatal(
      'Refusing without --confirm: resubscribing sends mail to someone who opted out.',
    );
  }
  const result = await api(
    'POST',
    `/_internal/v2/apps/${appId}/outbound-email/suppressions/remove`,
    { email: a.req('email') },
  );
  out(result);
  if (result?.platformSuppression) {
    const { reason, at } = result.platformSuppression;
    console.error(
      `\nNote: removed from this app's list, but ${a.req('email')} is still on the ` +
        `platform suppression list (${reason}${at ? ` since ${at}` : ''}). ` +
        `Mail to it will still be blocked — that list is account-wide and is not cleared.`,
    );
  }
}

export const emailHandlers = {
  'email list': emailList,
  'email get': emailGet,
  'email stats': emailStats,
  'email batches': emailBatches,
  'email batch': emailBatch,
  'email suppressions': emailSuppressions,
  'email suppress': emailSuppress,
  'email unsuppress': emailUnsuppress,
} satisfies Record<keyof typeof emailSpecs, Handler>;

export const emailHelp = `mindstudio-prod email — Outbound email delivery log, blast stats, and unsubscribes.

Subcommands:
  list           List sent messages (includes mail that never reached the provider)
  get            Full detail for one message, including bounce diagnostics
  stats          Counts and rates over a window
  batches        One row per blast, with per-status counts
  batch          Stats for a single blast
  suppressions   This app's unsubscribe list
  suppress       Add an address to the unsubscribe list
  unsuppress     Remove an address (requires --confirm)

Notes:
  Statuses: suppressed, failed, sent, delivered, blocked, bounced, complained,
  delayed, rejected. "blocked" means the platform-wide suppression list dropped
  it — usually another tenant's hard bounce — not that this address is bad.

  --recipient is an exact match and is index-backed; use --search for partials
  (bounded, and not paginated).

  A marketing send delivers one message per recipient, so a campaign is many
  rows sharing a batch id. Pass batchId to sendEmail to group them under your own
  campaign id.
`;
