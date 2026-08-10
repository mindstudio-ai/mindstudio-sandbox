import { type Args, type CommandSpec } from '../args.js';
import { api } from '../api.js';
import { fatal } from '../errors.js';
import { out } from '../output.js';
import type { Handler } from '../types.js';

export const dataSpecs = {
  'data lift-from-dev': {
    usage:
      'Usage: mindstudio-prod data lift-from-dev <appId> --confirm\n' +
      'Refusing to run without the exact appId and --confirm: this destructively ' +
      "replaces the live release's databases with a snapshot of dev. Wipes any " +
      'rows live had — including signed-up users. Intended for first-publish / ' +
      'pre-launch data sync only.',
    positionals: [{ name: 'appId', required: true }],
    flags: { confirm: { type: 'boolean' } },
    requireAnyOf: {
      flags: ['confirm'],
      message: 'Refusing to run without --confirm.',
    },
  },
  'data lift-from-live': {
    usage:
      'Usage: mindstudio-prod data lift-from-live [--truncate] --confirm\n' +
      'Refusing to run without --confirm: this destructively replaces the ' +
      "dev release's databases with a snapshot of live (wiping local dev " +
      'data). Live/prod data is never touched. With --truncate it instead ' +
      'empties the dev databases (keeps schema, no data pulled from live).',
    flags: { truncate: { type: 'boolean' }, confirm: { type: 'boolean' } },
    requireAnyOf: {
      flags: ['confirm'],
      message: 'Refusing to run without --confirm.',
    },
  },
} satisfies Record<string, CommandSpec>;

async function dataLiftFromDev(appId: string, a: Args) {
  // Typed appId, not just --confirm: this wipes live's databases including
  // signed-up users, and --confirm alone is trivially satisfiable by an agent
  // that read the help. Requiring the id forces a deliberate read.
  const given = a.req('appId');
  if (given !== appId) {
    fatal(
      `appId "${given}" does not match this workspace's app — re-run with the ` +
        'exact appId from mindstudio.json.',
    );
  }
  out(
    await api('POST', `/_internal/v2/apps/${appId}/manage/lift-dev-to-live`, {
      confirm: true,
    }),
  );
}
async function dataLiftFromLive(appId: string, a: Args) {
  const truncate = a.bool('truncate');
  out(
    await api('POST', `/_internal/v2/apps/${appId}/manage/lift-live-to-dev`, {
      confirm: true,
      ...(truncate ? { mode: 'truncate' } : {}),
    }),
  );
}

export const dataHandlers = {
  'data lift-from-dev': dataLiftFromDev,
  'data lift-from-live': dataLiftFromLive,
} satisfies Record<keyof typeof dataSpecs, Handler>;

export const dataHelp = `mindstudio-prod data — Database sync between dev and live.

Subcommands:
  lift-from-dev     Destructively replace live's databases with a snapshot of dev's.
  lift-from-live    Destructively replace dev's databases with a snapshot of live's.

Usage:
  mindstudio-prod data lift-from-dev <appId> --confirm
  mindstudio-prod data lift-from-live [--truncate] --confirm

What lift-from-dev does:
  Copies every live-release database from its dev-release counterpart by name
  match. Wipes whatever was on live. Schema metadata for the live release is
  updated to match dev. Database/table IDs stay stable — clients don't need
  to reload anything. Writes an audit row tagged 'lift-dev-to-live'.

What lift-from-live does:
  The reverse — pulls live's databases down over dev's, so the sandbox matches
  prod. Useful for reproducing a prod bug against real data or re-syncing a
  stale sandbox. Only dev is overwritten; live/prod data is never touched.
  Requires an existing dev release (start a dev session first). With --truncate
  it instead empties the dev databases (keeps schema + IDs, no data pulled from
  live). Writes an audit row tagged 'lift-live-to-dev'.

Critical constraints:
  - Whole-database overwrite, INCLUDING auth tables. lift-from-dev wipes live's
    users — intended for first-publish / pre-launch sync only; do NOT run on a
    production app with real users. (lift-from-live only wipes dev, so it's the
    safe direction.)
  - All-or-nothing per database. No per-table lift. To preserve some tables
    while replacing others, use a method invoked via 'methods invoke --roles'.
  - For lift-from-dev, the exact appId AND --confirm are both mandatory. The id
    must match mindstudio.json; --confirm alone is not enough, because this
    direction destroys live data. lift-from-live needs only --confirm.
  - Wait ~10s after a final write to the source before lifting (flush-loop race
    window).

Examples:
  mindstudio-prod data lift-from-dev app_abc123 --confirm
  mindstudio-prod data lift-from-live --confirm
  mindstudio-prod data lift-from-live --truncate --confirm`;
