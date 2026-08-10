import { WINDOW, type Args, type CommandSpec } from '../args.js';
import { api, seg } from '../api.js';
import { out } from '../output.js';
import type { Handler } from '../types.js';

export const crashesSpecs = {
  'crashes list': {
    usage:
      'Usage: mindstudio-prod crashes list [--release <releaseId>] [--sort recent|frequent] [--limit 50] [--start <ISO date>] [--end <ISO date>]',
    flags: {
      release: { type: 'string', param: 'releaseId' },
      sort: { type: 'string', param: 'sort' },
      limit: { type: 'number', param: 'limit', min: 0 },
      ...WINDOW,
    },
  },
  'crashes occurrences': {
    usage:
      'Usage: mindstudio-prod crashes occurrences <fingerprint> [--release <releaseId>] [--cursor <token>] [--limit 50] [--start <ISO date>] [--end <ISO date>]',
    positionals: [{ name: 'fingerprint', required: true }],
    flags: {
      release: { type: 'string', param: 'releaseId' },
      cursor: { type: 'string', param: 'cursor' },
      limit: { type: 'number', param: 'limit', min: 0 },
      ...WINDOW,
    },
  },
  'crashes get': {
    usage: 'Usage: mindstudio-prod crashes get <eventId>',
    positionals: [{ name: 'eventId', required: true }],
  },
  'crashes stats': {
    usage:
      'Usage: mindstudio-prod crashes stats [--release <releaseId>] [--start <ISO date>] [--end <ISO date>] [--buckets 24]',
    flags: {
      release: { type: 'string', param: 'releaseId' },
      ...WINDOW,
      buckets: { type: 'number', param: 'buckets', min: 1 },
    },
  },
} satisfies Record<string, CommandSpec>;

async function crashesList(appId: string, a: Args) {
  out(
    await api('GET', `/_internal/v2/apps/${appId}/frontend-errors${a.query()}`),
  );
}
async function crashesOccurrences(appId: string, a: Args) {
  out(
    await api(
      'GET',
      `/_internal/v2/apps/${appId}/frontend-errors/${seg(a.req('fingerprint'))}/events${a.query()}`,
    ),
  );
}
async function crashesGet(appId: string, a: Args) {
  out(
    await api(
      'GET',
      `/_internal/v2/apps/${appId}/frontend-errors/events/${seg(a.req('eventId'))}`,
    ),
  );
}
async function crashesStats(appId: string, a: Args) {
  out(
    await api(
      'GET',
      `/_internal/v2/apps/${appId}/frontend-errors/metrics/summary${a.query()}`,
    ),
  );
}

export const crashesHandlers = {
  'crashes list': crashesList,
  'crashes occurrences': crashesOccurrences,
  'crashes get': crashesGet,
  'crashes stats': crashesStats,
} satisfies Record<keyof typeof crashesSpecs, Handler>;

export const crashesHelp = `mindstudio-prod crashes — View frontend (browser) crash groups and events.

Crashes are grouped by fingerprint (Sentry-style): drill in via 'occurrences'.

Subcommands:
  list                       List crash groups (one row per fingerprint)
  occurrences <fingerprint>  List individual events for one crash group
  get <eventId>              Get full detail (stack + breadcrumbs) for one event
  stats                      Bucketed time series of total crash volume

Usage:
  mindstudio-prod crashes list [--release <releaseId>] [--sort recent|frequent] [--limit 50] [--start <ISO date>] [--end <ISO date>]
  mindstudio-prod crashes occurrences <fingerprint> [--release <releaseId>] [--cursor <token>] [--limit 50] [--start <ISO date>] [--end <ISO date>]
  mindstudio-prod crashes get <eventId>
  mindstudio-prod crashes stats [--release <releaseId>] [--start <ISO date>] [--end <ISO date>] [--buckets 24]

Examples:
  mindstudio-prod crashes list --sort frequent --limit 10
  mindstudio-prod crashes occurrences abc123fingerprint --limit 25
  mindstudio-prod crashes get evt_xyz789
  mindstudio-prod crashes stats --buckets 24

Notes:
  - 'list' returns groups, not individual events; each row has an exampleEventId
    you can pass to 'get' for a quick drill-in without paging occurrences.
  - 'occurrences' is cursor-paginated (not offset). Pass the returned cursor on
    the next call to fetch the next page.
  - Time-window defaults to the last 7 days when --start/--end are omitted.`;
