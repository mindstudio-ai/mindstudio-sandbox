import { WINDOW, type Args, type CommandSpec, type FlagSpec } from '../args.js';
import { api, seg } from '../api.js';
import { out } from '../output.js';
import type { Handler } from '../types.js';

export const TOP_DIMENSIONS = [
  'pages',
  'referrers',
  'countries',
  'devices',
  'browsers',
  'os',
  'languages',
  'source-categories',
  'utms',
  'sources',
] as const;

export const CRAWLERS_SUBS = ['overview', 'timeseries', 'recent'] as const;

/**
 * Shared analytics flags. Any filter flag switches the API read from the rollup
 * to the per-event table (30-day retention) — see HELP_ANALYTICS.
 */
const ANALYTICS = {
  release: { type: 'string', param: 'releaseId' },
  ...WINDOW,
  limit: { type: 'number', param: 'limit', min: 0 },
  path: { type: 'string', param: 'path' },
  referrer: { type: 'string', param: 'referrerHost' },
  country: { type: 'string', param: 'country' },
  city: { type: 'string', param: 'city' },
  device: { type: 'string', param: 'device' },
  browser: { type: 'string', param: 'browser' },
  os: { type: 'string', param: 'os' },
  language: { type: 'string', param: 'language' },
  'utm-source': { type: 'string', param: 'utmSource' },
  'utm-medium': { type: 'string', param: 'utmMedium' },
  'utm-campaign': { type: 'string', param: 'utmCampaign' },
} as const satisfies Record<string, FlagSpec>;

export const analyticsSpecs = {
  'analytics summary': {
    usage:
      'Usage: mindstudio-prod analytics summary [--release ...] [--start ...] [--end ...] [filters]',
    flags: ANALYTICS,
  },
  'analytics timeseries': {
    // `buckets` is declared last: the old code appended it after the shared query.
    usage:
      'Usage: mindstudio-prod analytics timeseries [--buckets 24] [shared flags]',
    flags: {
      ...ANALYTICS,
      buckets: { type: 'number', param: 'buckets', min: 1 },
    },
  },
  'analytics top': {
    usage: `Usage: mindstudio-prod analytics top <dimension>. Dimensions: ${TOP_DIMENSIONS.join('|')}`,
    positionals: [
      {
        name: 'dimension',
        required: true,
        choices: TOP_DIMENSIONS,
        choiceLabel: 'Unknown dimension',
      },
    ],
    flags: ANALYTICS,
  },
  'analytics events': {
    // Dual-mode: no positional lists event names, one gets stats for that event.
    usage: 'Usage: mindstudio-prod analytics events [<name>] [shared flags]',
    positionals: [{ name: 'name' }],
    flags: ANALYTICS,
  },
  'analytics map': {
    usage: 'Usage: mindstudio-prod analytics map [--limit 500] [shared flags]',
    flags: ANALYTICS,
  },
  'analytics live': {
    usage: 'Usage: mindstudio-prod analytics live',
  },
  'analytics ai-sources': {
    usage:
      'Usage: mindstudio-prod analytics ai-sources [--limit 25] [shared flags]',
    flags: ANALYTICS,
  },
  'analytics crawlers': {
    usage: `Usage: mindstudio-prod analytics crawlers <sub>. Subs: ${CRAWLERS_SUBS.join('|')}`,
    positionals: [
      {
        name: 'sub',
        required: true,
        choices: CRAWLERS_SUBS,
        choiceLabel: 'Unknown crawlers sub',
      },
    ],
    flags: ANALYTICS,
  },
} satisfies Record<string, CommandSpec>;

async function analyticsSummary(appId: string, a: Args) {
  out(
    await api(
      'GET',
      `/_internal/v2/apps/${appId}/insights/summary${a.query()}`,
    ),
  );
}
async function analyticsTimeseries(appId: string, a: Args) {
  out(
    await api(
      'GET',
      `/_internal/v2/apps/${appId}/insights/timeseries${a.query()}`,
    ),
  );
}
async function analyticsTop(appId: string, a: Args) {
  out(
    await api(
      'GET',
      `/_internal/v2/apps/${appId}/insights/top/${seg(a.req('dimension'))}${a.query()}`,
    ),
  );
}
async function analyticsEvents(appId: string, a: Args) {
  // Dual-mode: the optional positional becomes a `name` filter, appended after
  // the shared analytics params so the query string order is unchanged.
  const query = a.queryWith({ name: a.opt('name') });
  out(await api('GET', `/_internal/v2/apps/${appId}/insights/events${query}`));
}
async function analyticsMap(appId: string, a: Args) {
  out(await api('GET', `/_internal/v2/apps/${appId}/insights/map${a.query()}`));
}
async function analyticsLive(appId: string) {
  out(await api('GET', `/_internal/v2/apps/${appId}/insights/live`));
}
async function analyticsAiSources(appId: string, a: Args) {
  out(
    await api(
      'GET',
      `/_internal/v2/apps/${appId}/insights/ai-sources${a.query()}`,
    ),
  );
}
async function analyticsCrawlers(appId: string, a: Args) {
  out(
    await api(
      'GET',
      `/_internal/v2/apps/${appId}/insights/crawlers/${seg(a.req('sub'))}${a.query()}`,
    ),
  );
}

export const analyticsHandlers = {
  'analytics summary': analyticsSummary,
  'analytics timeseries': analyticsTimeseries,
  'analytics top': analyticsTop,
  'analytics events': analyticsEvents,
  'analytics map': analyticsMap,
  'analytics live': analyticsLive,
  'analytics ai-sources': analyticsAiSources,
  'analytics crawlers': analyticsCrawlers,
} satisfies Record<keyof typeof analyticsSpecs, Handler>;

export const analyticsHelp = `mindstudio-prod analytics — Traffic, top-N, geo, and AI-referral insights.

Subcommands:
  summary                        7-KPI snapshot + liveCount
  timeseries                     Pageviews / visits / uniques per bucket
  top <dimension>                Top-N by dimension (see list below)
  events [<name>]                Event-name list (no arg) or stats for one event
  map                            City lat/lon points for geo rendering
  live                           One-shot live counter (count + countries + sparkline)
  ai-sources                     Per-vendor AI-referral breakdown
  crawlers <overview|timeseries|recent>
                                 AI-crawler ingestion views

Top dimensions: pages | referrers | countries | devices | browsers | os |
                languages | source-categories | utms | sources

Shared flags (all optional):
  --release <id>                 Scope to one release
  --start <ISO date>             Window start
  --end <ISO date>               Window end
  --limit <n>                    Cap result count (where applicable)
  --buckets <n>                  Bucket count (timeseries only)
  Filter flags (any filter switches the read to per-event, 30-day retention):
    --path, --referrer, --country, --city, --device, --browser, --os,
    --language, --utm-source, --utm-medium, --utm-campaign

Usage:
  mindstudio-prod analytics summary [--release ...] [--start ...] [--end ...] [filters]
  mindstudio-prod analytics timeseries [--buckets 24] [shared flags]
  mindstudio-prod analytics top <dimension> [--limit 25] [shared flags]
  mindstudio-prod analytics events [<name>] [shared flags]
  mindstudio-prod analytics map [--limit 500] [shared flags]
  mindstudio-prod analytics live
  mindstudio-prod analytics ai-sources [--limit 25] [shared flags]
  mindstudio-prod analytics crawlers <overview|timeseries|recent> [shared flags]

Examples:
  mindstudio-prod analytics summary
  mindstudio-prod analytics summary --country US --device mobile
  mindstudio-prod analytics timeseries --buckets 24
  mindstudio-prod analytics top pages --limit 10
  mindstudio-prod analytics top sources --utm-source google
  mindstudio-prod analytics events
  mindstudio-prod analytics events checkout_clicked
  mindstudio-prod analytics crawlers recent

Notes:
  - Unfiltered queries hit the rollup (full history). Any filter flag switches
    to the per-event table, which has 30-day retention — older windows return
    empty for filtered reads.
  - 'events' is dual-mode: omit the positional to list event names; pass one
    to get stats for that single event.`;
