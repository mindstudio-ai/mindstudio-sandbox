import { WINDOW, type Args, type CommandSpec, type FlagSpec } from '../args.js';
import { api, seg } from '../api.js';
import { UsageError } from '../errors.js';
import { out } from '../output.js';
import type { Handler } from '../types.js';

const CRAWLERS_SUBS = ['overview', 'timeseries', 'recent'] as const;

/**
 * The 11 click-filter flags shared by the reads that honor them (sources,
 * map). Equality-only; richer filtering (is_not/contains, multi-value) lives
 * in the `query` JSON grammar.
 */
const FILTERS = {
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

const SCOPE = {
  release: { type: 'string', param: 'releaseId' },
  ...WINDOW,
} as const satisfies Record<string, FlagSpec>;

export const analyticsSpecs = {
  'analytics query': {
    usage: `Usage: mindstudio-prod analytics query '<json>'`,
    positionals: [{ name: 'body', required: true }],
  },
  'analytics batch': {
    usage: `Usage: mindstudio-prod analytics batch '<json array of query bodies>'`,
    positionals: [{ name: 'body', required: true }],
  },
  'analytics sources': {
    usage:
      'Usage: mindstudio-prod analytics sources [--limit 25] [--offset 0] [scope + filters]',
    flags: {
      ...SCOPE,
      limit: { type: 'number', param: 'limit', min: 0 },
      offset: { type: 'number', param: 'offset', min: 0 },
      ...FILTERS,
    },
  },
  'analytics map': {
    usage:
      'Usage: mindstudio-prod analytics map [--limit 500] [--offset 0] [scope + filters]',
    flags: {
      ...SCOPE,
      limit: { type: 'number', param: 'limit', min: 0 },
      offset: { type: 'number', param: 'offset', min: 0 },
      ...FILTERS,
    },
  },
  'analytics live': {
    usage: 'Usage: mindstudio-prod analytics live',
  },
  'analytics ai-sources': {
    usage:
      'Usage: mindstudio-prod analytics ai-sources [--limit 50] [--start ...] [--end ...] [--release ...]',
    flags: {
      ...SCOPE,
      limit: { type: 'number', param: 'limit', min: 0 },
    },
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
    // Union of the three subs' flags; the API ignores what a sub doesn't use.
    flags: {
      ...SCOPE,
      limit: { type: 'number', param: 'limit', min: 0 },
      buckets: { type: 'number', param: 'buckets', min: 1 },
      'top-pages-limit': { type: 'number', param: 'topPagesLimit', min: 1 },
    },
  },
} satisfies Record<string, CommandSpec>;

async function analyticsQuery(appId: string, a: Args) {
  const raw = a.req('body');
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch (err: any) {
    throw new UsageError(
      `analytics query body is not valid JSON (${err.message}). Run 'mindstudio-prod analytics --help' for the grammar.`,
      analyticsSpecs['analytics query'].usage,
    );
  }
  out(
    await api(
      'POST',
      `/_internal/v2/apps/${appId}/insights/query`,
      body as Record<string, unknown>,
    ),
  );
}
async function analyticsBatch(appId: string, a: Args) {
  const raw = a.req('body');
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch (err: any) {
    throw new UsageError(
      `analytics batch body is not valid JSON (${err.message}). Pass an array of query bodies.`,
      analyticsSpecs['analytics batch'].usage,
    );
  }
  // Accept a bare array or the wire shape {queries: [...]}.
  const queries = Array.isArray(body) ? body : (body as any)?.queries;
  out(
    await api('POST', `/_internal/v2/apps/${appId}/insights/query-batch`, {
      queries,
    }),
  );
}
async function analyticsSources(appId: string, a: Args) {
  out(
    await api(
      'GET',
      `/_internal/v2/apps/${appId}/insights/sources${a.query()}`,
    ),
  );
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
  'analytics query': analyticsQuery,
  'analytics batch': analyticsBatch,
  'analytics sources': analyticsSources,
  'analytics map': analyticsMap,
  'analytics live': analyticsLive,
  'analytics ai-sources': analyticsAiSources,
  'analytics crawlers': analyticsCrawlers,
} satisfies Record<keyof typeof analyticsSpecs, Handler>;

export const analyticsHelp = `mindstudio-prod analytics — Traffic, top-N, geo, and AI-referral insights.

Subcommands:
  query '<json>'                 The general read: metrics x dimensions x
                                 filters x time (summary KPIs, timeseries,
                                 top-N, and event stats are all query shapes)
  batch '<json array>'           Up to 10 query bodies in one round trip;
                                 results in request order
  sources                        Ranked traffic sources (per-session first
                                 source: UTM > referrer > direct, classified)
  map                            City lat/lon points for geo rendering
  live                           One-shot live counter (count + countries + sparkline)
  ai-sources                     Per-vendor AI-referral breakdown
  crawlers <overview|timeseries|recent>
                                 AI-crawler / bot ingestion views

The query JSON body:
  metrics      required: ["pageviews" | "visitors" | "visits" | "events", ...]
  dimensions   at most ONE entity dimension OR "time" (not both):
               path referrerHost sourceCategory country city deviceType
               browser os language visitorType utmSource utmMedium
               utmCampaign utmTerm utmContent eventName
  granularity  required with "time": "5m" | "hour" | "day" | "week" | "month"
  timezone     IANA zone for day/week/month boundaries (default UTC)
  filters      [[op, dimension, [values...]], ...]
               ops: "is" (any of) | "is_not" (none of; missing still matches)
                    | "contains" (case-insensitive substring)
  dateRange    "1h" | "24h" | "7d" | "30d" | "90d" | "all"
               or ["<startISO>", "<endISO>"]   (default "24h")
               with "all", granularity is a minimum (server coarsens as
               history grows); city filter values are plain city names
  orderBy      grouped only: [["pageviews" | "events", "asc" | "desc"]]
  limit        grouped only, default 25, max 1000; offset for paging
  releaseId    optional release scope

How far back a query can look depends on its shape: all-"is" filters touching
at most ONE dimension read a rollup kept forever (full lifetime history);
cross-dimension, "is_not", and "contains" queries scan raw events retained 90
days — the server clamps the window. The response meta says what happened:
source ("rollup" | "events"), window.served, clamped, metricsOmitted (metrics
this shape can't carry — e.g. visits on grouped reads), total (group count).

Shared flags on sources/map/ai-sources/crawlers:
  --release <id>, --start <ISO>, --end <ISO>, --limit <n>
  sources/map also take --offset and the click-filters: --path, --referrer,
  --country, --city, --device, --browser, --os, --language, --utm-source,
  --utm-medium, --utm-campaign (equality; per-event backed, 90-day retention)
  crawlers: --buckets (timeseries), --top-pages-limit (overview)

Examples:
  # Summary KPIs for the last 24h
  mindstudio-prod analytics query '{"metrics":["pageviews","visits","visitors"]}'

  # Top pages, all time
  mindstudio-prod analytics query '{"metrics":["pageviews","visitors"],"dimensions":["path"],"dateRange":"all","limit":10}'

  # Daily views for one post, full history
  mindstudio-prod analytics query '{"metrics":["pageviews"],"dimensions":["time"],"granularity":"day","filters":[["is","path",["/post/hello"]]],"dateRange":"all"}'

  # Summary KPIs + top pages in one round trip
  mindstudio-prod analytics batch '[{"metrics":["pageviews","visits","visitors"]},{"metrics":["pageviews"],"dimensions":["path"],"limit":10}]'

  # Custom-event breakdown over 30 days
  mindstudio-prod analytics query '{"metrics":["events","visitors"],"dimensions":["eventName"],"dateRange":"30d"}'

  # Mobile traffic by country (cross-dimension -> 90-day window)
  mindstudio-prod analytics query '{"metrics":["pageviews"],"dimensions":["country"],"filters":[["is","deviceType",["mobile"]]],"dateRange":"30d"}'

  mindstudio-prod analytics sources --limit 10
  mindstudio-prod analytics live
  mindstudio-prod analytics crawlers recent`;
