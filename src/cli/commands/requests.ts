import { PAGINATION, WINDOW, type Args, type CommandSpec } from '../args.js';
import { api, seg } from '../api.js';
import { out } from '../output.js';
import type { Handler } from '../types.js';

export const requestsSpecs = {
  'requests list': {
    usage:
      'Usage: mindstudio-prod requests list [--method <methodId>] [--status success|error] [--limit 50] [--offset 0]',
    flags: {
      method: { type: 'string', param: 'methodId' },
      status: { type: 'string', param: 'status' },
      ...PAGINATION,
    },
  },
  'requests get': {
    usage: 'Usage: mindstudio-prod requests get <requestId>',
    positionals: [{ name: 'requestId', required: true }],
  },
  'requests stats': {
    // `--method` selects a different endpoint here, so it is not a query param.
    usage:
      'Usage: mindstudio-prod requests stats [--method <methodId>] [--start <ISO date>] [--end <ISO date>]',
    flags: { method: { type: 'string' }, ...WINDOW },
  },
} satisfies Record<string, CommandSpec>;

async function requestsList(appId: string, a: Args) {
  out(await api('GET', `/_internal/v2/apps/${appId}/requests${a.query()}`));
}
async function requestsGet(appId: string, a: Args) {
  out(
    await api(
      'GET',
      `/_internal/v2/apps/${appId}/requests/${seg(a.req('requestId'))}`,
    ),
  );
}
async function requestsStats(appId: string, a: Args) {
  const method = a.str('method');
  if (method) {
    out(
      await api(
        'GET',
        `/_internal/v2/apps/${appId}/metrics/methods/${seg(method)}${a.query()}`,
      ),
    );
  } else {
    out(
      await api(
        'GET',
        `/_internal/v2/apps/${appId}/metrics/summary${a.query()}`,
      ),
    );
  }
}

export const requestsHandlers = {
  'requests list': requestsList,
  'requests get': requestsGet,
  'requests stats': requestsStats,
} satisfies Record<keyof typeof requestsSpecs, Handler>;

export const requestsHelp = `mindstudio-prod requests — View request logs and metrics.

Subcommands:
  list    List recent requests
  get     Get full details of a specific request
  stats   View aggregated metrics

Usage:
  mindstudio-prod requests list [--method <methodId>] [--status success|error] [--limit 50] [--offset 0]
  mindstudio-prod requests get <requestId>
  mindstudio-prod requests stats [--method <methodId>] [--start <ISO date>] [--end <ISO date>]

Examples:
  mindstudio-prod requests list --limit 10
  mindstudio-prod requests list --method mth_abc123 --status error
  mindstudio-prod requests get req_abc123
  mindstudio-prod requests stats
  mindstudio-prod requests stats --method mth_abc123`;
