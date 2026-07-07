#!/usr/bin/env node

/**
 * mindstudio-prod — CLI for managing production MindStudio apps.
 *
 * Designed to be invoked by remy via its bash tool. All command output
 * is JSON (one object per line). Help text is plain text so remy can
 * discover capabilities via `mindstudio-prod --help`.
 *
 * Config is read from environment variables (MINDSTUDIO_API_KEY,
 * API_BASE_URL) and the workspace's mindstudio.json (for appId).
 */

import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const API_KEY = process.env['MINDSTUDIO_API_KEY'] ?? '';
const API_BASE = process.env['API_BASE_URL'] || 'https://api.mindstudio.ai';
const WORKSPACE_DIR =
  process.env['WORKSPACE_DIR'] || '/home/vercel-sandbox/workspace';

function loadAppId(): string {
  const manifestPath = path.join(WORKSPACE_DIR, 'mindstudio.json');
  try {
    const raw = fs.readFileSync(manifestPath, 'utf-8');
    const manifest = JSON.parse(raw);
    if (!manifest.appId) {
      fatal('mindstudio.json exists but has no appId');
    }
    return manifest.appId;
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      fatal(`mindstudio.json not found at ${manifestPath}`);
    }
    fatal(`Failed to read mindstudio.json: ${err.message}`);
  }
}

function fatal(message: string): never {
  console.log(JSON.stringify({ error: message }));
  process.exit(1);
}

function out(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

// ---------------------------------------------------------------------------
// API client
// ---------------------------------------------------------------------------

async function api(
  method: string,
  apiPath: string,
  body?: Record<string, unknown>,
): Promise<any> {
  const url = `${API_BASE}${apiPath}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${API_KEY}`,
    'Content-Type': 'application/json',
  };

  const res = await fetch(url, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  if (!res.ok) {
    let errorBody: any;
    try {
      errorBody = await res.json();
    } catch {
      errorBody = { message: await res.text() };
    }
    fatal(
      `API ${method} ${apiPath} returned ${res.status}: ${JSON.stringify(errorBody)}`,
    );
  }

  return res.json();
}

async function apiStream(
  apiPath: string,
  body: Record<string, unknown>,
): Promise<void> {
  const url = `${API_BASE}${apiPath}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    let errorBody: any;
    try {
      errorBody = await res.json();
    } catch {
      errorBody = { message: await res.text() };
    }
    fatal(
      `API POST ${apiPath} returned ${res.status}: ${JSON.stringify(errorBody)}`,
    );
  }

  if (!res.body) {
    fatal('Stream response has no body');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop()!;
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        try {
          const data = JSON.parse(line.slice(6));
          out(data);
        } catch {
          // skip unparseable SSE lines
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

function getFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(`--${flag}`);
  if (idx === -1 || idx + 1 >= args.length) {
    return undefined;
  }
  return args[idx + 1];
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(`--${flag}`);
}

function getPositional(args: string[], index: number): string | undefined {
  // Skip --flag value pairs, return the nth non-flag positional
  let pos = 0;
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      i++; // skip flag value
      continue;
    }
    if (pos === index) {
      return args[i];
    }
    pos++;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Commands — requests
// ---------------------------------------------------------------------------

async function requestsList(appId: string, args: string[]) {
  const params = new URLSearchParams();
  const method = getFlag(args, 'method');
  const status = getFlag(args, 'status');
  const limit = getFlag(args, 'limit');
  const offset = getFlag(args, 'offset');
  if (method) {
    params.set('methodId', method);
  }
  if (status) {
    params.set('status', status);
  }
  if (limit) {
    params.set('limit', limit);
  }
  if (offset) {
    params.set('offset', offset);
  }
  const qs = params.toString() ? `?${params}` : '';
  out(await api('GET', `/_internal/v2/apps/${appId}/requests${qs}`));
}

async function requestsGet(appId: string, args: string[]) {
  const requestId = getPositional(args, 0);
  if (!requestId) {
    fatal('Usage: mindstudio-prod requests get <requestId>');
  }
  out(await api('GET', `/_internal/v2/apps/${appId}/requests/${requestId}`));
}

async function requestsStats(appId: string, args: string[]) {
  const method = getFlag(args, 'method');
  const params = new URLSearchParams();
  const start = getFlag(args, 'start');
  const end = getFlag(args, 'end');
  if (start) {
    params.set('start', start);
  }
  if (end) {
    params.set('end', end);
  }
  const qs = params.toString() ? `?${params}` : '';

  if (method) {
    out(
      await api(
        'GET',
        `/_internal/v2/apps/${appId}/metrics/methods/${method}${qs}`,
      ),
    );
  } else {
    out(await api('GET', `/_internal/v2/apps/${appId}/metrics/summary${qs}`));
  }
}

// ---------------------------------------------------------------------------
// Commands — crashes (frontend errors)
// ---------------------------------------------------------------------------

async function crashesList(appId: string, args: string[]) {
  const params = new URLSearchParams();
  const release = getFlag(args, 'release');
  const sort = getFlag(args, 'sort');
  const limit = getFlag(args, 'limit');
  const start = getFlag(args, 'start');
  const end = getFlag(args, 'end');
  if (release) {
    params.set('releaseId', release);
  }
  if (sort) {
    params.set('sort', sort);
  }
  if (limit) {
    params.set('limit', limit);
  }
  if (start) {
    params.set('start', start);
  }
  if (end) {
    params.set('end', end);
  }
  const qs = params.toString() ? `?${params}` : '';
  out(await api('GET', `/_internal/v2/apps/${appId}/frontend-errors${qs}`));
}

async function crashesOccurrences(appId: string, args: string[]) {
  const fingerprint = getPositional(args, 0);
  if (!fingerprint) {
    fatal('Usage: mindstudio-prod crashes occurrences <fingerprint>');
  }
  const params = new URLSearchParams();
  const release = getFlag(args, 'release');
  const cursor = getFlag(args, 'cursor');
  const limit = getFlag(args, 'limit');
  const start = getFlag(args, 'start');
  const end = getFlag(args, 'end');
  if (release) {
    params.set('releaseId', release);
  }
  if (cursor) {
    params.set('cursor', cursor);
  }
  if (limit) {
    params.set('limit', limit);
  }
  if (start) {
    params.set('start', start);
  }
  if (end) {
    params.set('end', end);
  }
  const qs = params.toString() ? `?${params}` : '';
  out(
    await api(
      'GET',
      `/_internal/v2/apps/${appId}/frontend-errors/${fingerprint}/events${qs}`,
    ),
  );
}

async function crashesGet(appId: string, args: string[]) {
  const eventId = getPositional(args, 0);
  if (!eventId) {
    fatal('Usage: mindstudio-prod crashes get <eventId>');
  }
  out(
    await api(
      'GET',
      `/_internal/v2/apps/${appId}/frontend-errors/events/${eventId}`,
    ),
  );
}

async function crashesStats(appId: string, args: string[]) {
  const params = new URLSearchParams();
  const release = getFlag(args, 'release');
  const start = getFlag(args, 'start');
  const end = getFlag(args, 'end');
  const buckets = getFlag(args, 'buckets');
  if (release) {
    params.set('releaseId', release);
  }
  if (start) {
    params.set('start', start);
  }
  if (end) {
    params.set('end', end);
  }
  if (buckets) {
    params.set('buckets', buckets);
  }
  const qs = params.toString() ? `?${params}` : '';
  out(
    await api(
      'GET',
      `/_internal/v2/apps/${appId}/frontend-errors/metrics/summary${qs}`,
    ),
  );
}

// ---------------------------------------------------------------------------
// Commands — analytics (insights)
// ---------------------------------------------------------------------------

const TOP_DIMENSIONS = [
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

const CRAWLERS_SUBS = ['overview', 'timeseries', 'recent'] as const;

// Hyphenated CLI flag -> API query param (camelCase). Hits the per-event
// table on the API side (30-day retention) instead of the rollup.
const ANALYTICS_FILTER_FLAGS: Array<[string, string]> = [
  ['path', 'path'],
  ['referrer', 'referrerHost'],
  ['country', 'country'],
  ['city', 'city'],
  ['device', 'device'],
  ['browser', 'browser'],
  ['os', 'os'],
  ['language', 'language'],
  ['utm-source', 'utmSource'],
  ['utm-medium', 'utmMedium'],
  ['utm-campaign', 'utmCampaign'],
];

function buildAnalyticsQuery(args: string[]): URLSearchParams {
  const params = new URLSearchParams();
  const release = getFlag(args, 'release');
  const start = getFlag(args, 'start');
  const end = getFlag(args, 'end');
  const limit = getFlag(args, 'limit');
  if (release) {
    params.set('releaseId', release);
  }
  if (start) {
    params.set('start', start);
  }
  if (end) {
    params.set('end', end);
  }
  if (limit) {
    params.set('limit', limit);
  }
  for (const [flag, param] of ANALYTICS_FILTER_FLAGS) {
    const value = getFlag(args, flag);
    if (value) {
      params.set(param, value);
    }
  }
  return params;
}

function qs(params: URLSearchParams): string {
  return params.toString() ? `?${params}` : '';
}

async function analyticsSummary(appId: string, args: string[]) {
  const params = buildAnalyticsQuery(args);
  out(
    await api(
      'GET',
      `/_internal/v2/apps/${appId}/insights/summary${qs(params)}`,
    ),
  );
}

async function analyticsTimeseries(appId: string, args: string[]) {
  const params = buildAnalyticsQuery(args);
  const buckets = getFlag(args, 'buckets');
  if (buckets) {
    params.set('buckets', buckets);
  }
  out(
    await api(
      'GET',
      `/_internal/v2/apps/${appId}/insights/timeseries${qs(params)}`,
    ),
  );
}

async function analyticsTop(appId: string, args: string[]) {
  const dimension = getPositional(args, 0);
  if (!dimension) {
    fatal(
      `Usage: mindstudio-prod analytics top <dimension>. Dimensions: ${TOP_DIMENSIONS.join('|')}`,
    );
  }
  if (!(TOP_DIMENSIONS as readonly string[]).includes(dimension)) {
    fatal(
      `Unknown dimension "${dimension}". Valid: ${TOP_DIMENSIONS.join('|')}`,
    );
  }
  const params = buildAnalyticsQuery(args);
  out(
    await api(
      'GET',
      `/_internal/v2/apps/${appId}/insights/top/${dimension}${qs(params)}`,
    ),
  );
}

async function analyticsEvents(appId: string, args: string[]) {
  const name = getPositional(args, 0);
  const params = buildAnalyticsQuery(args);
  if (name) {
    params.set('name', name);
  }
  out(
    await api(
      'GET',
      `/_internal/v2/apps/${appId}/insights/events${qs(params)}`,
    ),
  );
}

async function analyticsMap(appId: string, args: string[]) {
  const params = buildAnalyticsQuery(args);
  out(
    await api('GET', `/_internal/v2/apps/${appId}/insights/map${qs(params)}`),
  );
}

async function analyticsLive(appId: string) {
  out(await api('GET', `/_internal/v2/apps/${appId}/insights/live`));
}

async function analyticsAiSources(appId: string, args: string[]) {
  const params = buildAnalyticsQuery(args);
  out(
    await api(
      'GET',
      `/_internal/v2/apps/${appId}/insights/ai-sources${qs(params)}`,
    ),
  );
}

async function analyticsCrawlers(appId: string, args: string[]) {
  const sub = getPositional(args, 0);
  if (!sub) {
    fatal(
      `Usage: mindstudio-prod analytics crawlers <sub>. Subs: ${CRAWLERS_SUBS.join('|')}`,
    );
  }
  if (!(CRAWLERS_SUBS as readonly string[]).includes(sub)) {
    fatal(`Unknown crawlers sub "${sub}". Valid: ${CRAWLERS_SUBS.join('|')}`);
  }
  const params = buildAnalyticsQuery(args);
  out(
    await api(
      'GET',
      `/_internal/v2/apps/${appId}/insights/crawlers/${sub}${qs(params)}`,
    ),
  );
}

// ---------------------------------------------------------------------------
// Commands — releases
// ---------------------------------------------------------------------------

async function releasesList(appId: string) {
  const dashboard = await api('GET', `/_internal/v2/apps/${appId}/dashboard`);
  out(dashboard.releases ?? []);
}

async function releasesGet(appId: string, args: string[]) {
  const releaseId = getPositional(args, 0);
  if (!releaseId) {
    fatal('Usage: mindstudio-prod releases get <releaseId>');
  }
  out(await api('GET', `/_internal/v2/apps/${appId}/releases/${releaseId}`));
}

async function releasesCurrent(appId: string) {
  const dashboard = await api('GET', `/_internal/v2/apps/${appId}/dashboard`);
  if (!dashboard.liveRelease) {
    out({ error: 'No live release', liveRelease: null });
  } else {
    out(dashboard.liveRelease);
  }
}

async function releasesStatus(appId: string, args: string[]) {
  const releaseId = getPositional(args, 0);
  if (!releaseId) {
    fatal(
      'Usage: mindstudio-prod releases status <releaseId> [--wait] [--timeout 120]',
    );
  }

  const wait = hasFlag(args, 'wait');
  const timeout = parseInt(getFlag(args, 'timeout') ?? '120', 10) * 1000;
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
      `/_internal/v2/apps/${appId}/releases/${releaseId}`,
    );
    out(release);
    return;
  }

  // Poll silently, only print the final result
  while (true) {
    const release = await api(
      'GET',
      `/_internal/v2/apps/${appId}/releases/${releaseId}`,
    );

    if (TERMINAL.has(release.status)) {
      out(release);
      return;
    }

    if (Date.now() - startTime > timeout) {
      fatal(`Timed out waiting for release ${releaseId} (${timeout / 1000}s)`);
    }

    await new Promise((r) => setTimeout(r, 3000));
  }
}

// ---------------------------------------------------------------------------
// Commands — domains
// ---------------------------------------------------------------------------

async function domainsGet(appId: string) {
  out(
    await api('GET', `/_internal/v2/apps/${appId}/settings/custom-subdomain`),
  );
}

async function domainsSet(appId: string, args: string[]) {
  const subdomain = getPositional(args, 0);
  if (!subdomain) {
    fatal('Usage: mindstudio-prod domains set <subdomain>');
  }
  out(
    await api('POST', `/_internal/v2/apps/${appId}/settings/custom-subdomain`, {
      subdomain,
    }),
  );
}

async function domainsCheck(appId: string, args: string[]) {
  const subdomain = getPositional(args, 0);
  if (!subdomain) {
    fatal('Usage: mindstudio-prod domains check <subdomain>');
  }
  out(
    await api(
      'POST',
      `/_internal/v2/apps/${appId}/settings/custom-subdomain/check-availability`,
      { subdomain },
    ),
  );
}

// ---------------------------------------------------------------------------
// Commands — custom domains
// ---------------------------------------------------------------------------

// Resolve an id from a user-supplied hostname by listing and matching
// against the canonical lowercase hostname. Fatal if not found. Used by
// the two-call /:id/delete and /:id/retry endpoints, and by the
// filter-and-render `records`/`status` views.
async function findHostnameId(
  appId: string,
  hostname: string,
): Promise<{ id: string; entry: any }> {
  const wanted = hostname.toLowerCase();
  const res = await api(
    'GET',
    `/_internal/v2/apps/${appId}/settings/custom-domains`,
  );
  const entry = (res.hostnames ?? []).find(
    (h: any) => typeof h.hostname === 'string' && h.hostname === wanted,
  );
  if (!entry) {
    fatal(`No custom domain "${hostname}" found on this app`);
  }
  return { id: entry.id, entry };
}

async function customDomainsList(appId: string) {
  out(await api('GET', `/_internal/v2/apps/${appId}/settings/custom-domains`));
}

async function customDomainsAdd(appId: string, args: string[]) {
  const hostname = getPositional(args, 0);
  if (!hostname) {
    fatal('Usage: mindstudio-prod domains custom add <hostname>');
  }
  out(
    await api('POST', `/_internal/v2/apps/${appId}/settings/custom-domains`, {
      hostname,
    }),
  );
}

async function customDomainsCheck(appId: string, args: string[]) {
  const hostname = getPositional(args, 0);
  if (!hostname) {
    fatal('Usage: mindstudio-prod domains custom check <hostname>');
  }
  out(
    await api(
      'POST',
      `/_internal/v2/apps/${appId}/settings/custom-domains/check-domain`,
      { hostname },
    ),
  );
}

async function customDomainsRecords(appId: string, args: string[]) {
  const hostname = getPositional(args, 0);
  if (!hostname) {
    fatal('Usage: mindstudio-prod domains custom records <hostname>');
  }
  const { entry } = await findHostnameId(appId, hostname);
  out({
    hostname: entry.hostname,
    isApex: entry.isApex,
    dnsInstructions: entry.dnsInstructions,
  });
}

async function customDomainsStatus(appId: string, args: string[]) {
  const hostname = getPositional(args, 0);
  if (!hostname) {
    fatal('Usage: mindstudio-prod domains custom status <hostname>');
  }
  const { entry } = await findHostnameId(appId, hostname);
  out({
    hostname: entry.hostname,
    uiStatus: entry.uiStatus,
    verificationErrors: entry.verificationErrors ?? null,
    cfStatus: entry.cfStatus,
    cfSslStatus: entry.cfSslStatus,
  });
}

async function customDomainsRemove(appId: string, args: string[]) {
  const hostname = getPositional(args, 0);
  if (!hostname) {
    fatal('Usage: mindstudio-prod domains custom remove <hostname>');
  }
  const { id } = await findHostnameId(appId, hostname);
  out(
    await api(
      'POST',
      `/_internal/v2/apps/${appId}/settings/custom-domains/${id}/delete`,
    ),
  );
}

async function customDomainsRetry(appId: string, args: string[]) {
  const hostname = getPositional(args, 0);
  if (!hostname) {
    fatal('Usage: mindstudio-prod domains custom retry <hostname>');
  }
  const { id } = await findHostnameId(appId, hostname);
  out(
    await api(
      'POST',
      `/_internal/v2/apps/${appId}/settings/custom-domains/${id}/retry`,
    ),
  );
}

// ---------------------------------------------------------------------------
// Commands — users
// ---------------------------------------------------------------------------

async function usersList(appId: string, args: string[]) {
  const params = new URLSearchParams();
  const limit = getFlag(args, 'limit');
  const offset = getFlag(args, 'offset');
  if (limit) {
    params.set('limit', limit);
  }
  if (offset) {
    params.set('offset', offset);
  }
  const qs = params.toString() ? `?${params}` : '';
  out(await api('GET', `/_internal/v2/apps/${appId}/users${qs}`));
}

async function usersCreateApiKey(appId: string, args: string[]) {
  const userId = getPositional(args, 0);
  if (!userId) {
    fatal('Usage: mindstudio-prod users create-api-key <userId>');
  }
  out(await api('POST', `/_internal/v2/apps/${appId}/users/${userId}/api-key`));
}

async function usersRevokeApiKey(appId: string, args: string[]) {
  const userId = getPositional(args, 0);
  if (!userId) {
    fatal('Usage: mindstudio-prod users revoke-api-key <userId>');
  }
  out(
    await api('DELETE', `/_internal/v2/apps/${appId}/users/${userId}/api-key`),
  );
}

async function usersSetRole(appId: string, args: string[]) {
  const userId = getPositional(args, 0);
  const role = getPositional(args, 1);
  if (!userId || !role) {
    fatal('Usage: mindstudio-prod users set-role <userId> <role>');
  }
  out(
    await api('POST', `/_internal/v2/apps/${appId}/users/${userId}/roles`, {
      roles: [role],
    }),
  );
}

// ---------------------------------------------------------------------------
// Commands — db
// ---------------------------------------------------------------------------

async function dbQuery(appId: string, args: string[]) {
  const sql = getPositional(args, 0);
  if (!sql) {
    fatal('Usage: mindstudio-prod db query <sql>');
  }
  out(
    await api('POST', `/_internal/v2/apps/${appId}/db/query`, {
      queries: [{ sql }],
    }),
  );
}

async function dbTables(appId: string) {
  out(
    await api('POST', `/_internal/v2/apps/${appId}/db/query`, {
      queries: [
        {
          sql: "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        },
      ],
    }),
  );
}

// ---------------------------------------------------------------------------
// Commands — secrets
// ---------------------------------------------------------------------------

async function secretsList(appId: string) {
  out(await api('GET', `/_internal/v2/apps/${appId}/secrets`));
}

async function secretsGet(appId: string, args: string[]) {
  const key = getPositional(args, 0);
  if (!key) {
    fatal('Usage: mindstudio-prod secrets get <KEY>');
  }
  out(await api('GET', `/_internal/v2/apps/${appId}/secrets/${key}`));
}

async function secretsSet(appId: string, args: string[]) {
  const key = getPositional(args, 0);
  if (!key) {
    fatal(
      'Usage: mindstudio-prod secrets set <KEY> [--dev <value>] [--prod <value>] [--dev-clear] [--prod-clear]',
    );
  }

  const body: Record<string, unknown> = {};
  const dev = getFlag(args, 'dev');
  const prod = getFlag(args, 'prod');
  const devClear = hasFlag(args, 'dev-clear');
  const prodClear = hasFlag(args, 'prod-clear');

  if (dev !== undefined) {
    body.devValue = dev;
  } else if (devClear) {
    body.devValue = null;
  }

  if (prod !== undefined) {
    body.prodValue = prod;
  } else if (prodClear) {
    body.prodValue = null;
  }

  if (!('devValue' in body) && !('prodValue' in body)) {
    fatal(
      'At least one of --dev <value>, --prod <value>, --dev-clear, or --prod-clear is required',
    );
  }

  out(await api('PUT', `/_internal/v2/apps/${appId}/secrets/${key}`, body));
}

async function secretsDelete(appId: string, args: string[]) {
  const key = getPositional(args, 0);
  if (!key) {
    fatal('Usage: mindstudio-prod secrets delete <KEY>');
  }
  out(await api('DELETE', `/_internal/v2/apps/${appId}/secrets/${key}`));
}

// ---------------------------------------------------------------------------
// Commands — data
// ---------------------------------------------------------------------------

async function dataLiftFromDev(appId: string, args: string[]) {
  if (!hasFlag(args, 'confirm')) {
    fatal(
      'Usage: mindstudio-prod data lift-from-dev --confirm\n' +
        'Refusing to run without --confirm: this destructively replaces the ' +
        "live release's databases with a snapshot of dev. Wipes any rows " +
        'live had — including signed-up users. Intended for first-publish / ' +
        'pre-launch data sync only.',
    );
  }
  out(
    await api('POST', `/_internal/v2/apps/${appId}/manage/lift-dev-to-live`, {
      confirm: true,
    }),
  );
}

// ---------------------------------------------------------------------------
// Commands — methods
// ---------------------------------------------------------------------------

async function methodsList(appId: string) {
  const dashboard = await api('GET', `/_internal/v2/apps/${appId}/dashboard`);
  const release = dashboard.liveRelease;
  if (!release) {
    out({ error: 'No live release', methods: [] });
    return;
  }
  // Extract method info from the release's build stats or manifest
  out(release.methods ?? []);
}

async function methodsInvoke(appId: string, args: string[]) {
  const methodId = getPositional(args, 0);
  if (!methodId) {
    fatal(
      'Usage: mindstudio-prod methods invoke <methodId> [--input \'{"key":"value"}\'] [--stream] [--roles <a,b,c>] [--user-id <userId>]',
    );
  }

  const inputRaw = getFlag(args, 'input');
  let input: Record<string, any> = {};
  if (inputRaw) {
    try {
      input = JSON.parse(inputRaw);
    } catch {
      fatal(`Invalid JSON for --input: ${inputRaw}`);
    }
  }

  // Optional impersonation. If either flag is set we hit /invoke-as instead
  // of /invoke so the method runs with the supplied roles / user identity
  // (lets the CLI test role-gated methods without spec edits).
  const rolesRaw = getFlag(args, 'roles');
  const userId = getFlag(args, 'user-id');
  const impersonate: { roles?: string[]; userId?: string } = {};
  if (rolesRaw) {
    impersonate.roles = rolesRaw
      .split(',')
      .map((r) => r.trim())
      .filter(Boolean);
  }
  if (userId) {
    impersonate.userId = userId;
  }
  const useImpersonate =
    impersonate.roles !== undefined || impersonate.userId !== undefined;

  const stream = hasFlag(args, 'stream');
  const apiPath = useImpersonate
    ? `/_internal/v2/apps/${appId}/methods/${methodId}/invoke-as`
    : `/_internal/v2/apps/${appId}/methods/${methodId}/invoke`;
  const body: Record<string, unknown> = useImpersonate
    ? { input, impersonate }
    : { input };

  if (stream) {
    await apiStream(apiPath, { ...body, stream: true });
  } else {
    out(await api('POST', apiPath, body));
  }
}

// ---------------------------------------------------------------------------
// Commands — issues
// ---------------------------------------------------------------------------

// Resolve a --body value: `--body -` reads stdin (for long multi-line
// markdown remy generates); `--body <text>` uses the literal; absent → undefined.
function readBodyFlag(args: string[]): string | undefined {
  const val = getFlag(args, 'body');
  if (val === undefined) {
    return undefined;
  }
  if (val === '-') {
    return fs.readFileSync(0, 'utf-8');
  }
  return val;
}

async function issuesList(appId: string, args: string[]) {
  const params = new URLSearchParams();
  const status = getFlag(args, 'status');
  const kind = getFlag(args, 'kind');
  const limit = getFlag(args, 'limit');
  const cursor = getFlag(args, 'cursor');
  if (status) {
    params.set('status', status);
  }
  if (kind) {
    params.set('kind', kind);
  }
  if (limit) {
    params.set('limit', limit);
  }
  if (cursor) {
    params.set('cursor', cursor);
  }
  const q = params.toString();
  out(
    await api('GET', `/_internal/v2/apps/${appId}/issues${q ? `?${q}` : ''}`),
  );
}

async function issuesGet(appId: string, args: string[]) {
  const number = getPositional(args, 0);
  if (!number) {
    fatal('Usage: mindstudio-prod issues get <number>');
  }
  out(await api('GET', `/_internal/v2/apps/${appId}/issues/${number}`));
}

async function issuesCreate(appId: string, args: string[]) {
  const title = getPositional(args, 0);
  if (!title) {
    fatal(
      'Usage: mindstudio-prod issues create <title> [--body <text>|--body -] [--kind bug|idea|task]',
    );
  }
  // Everything the CLI files is authored as the agent.
  const body: Record<string, unknown> = { title, authorKind: 'agent' };
  const issueBody = readBodyFlag(args);
  if (issueBody !== undefined) {
    body.body = issueBody;
  }
  const kind = getFlag(args, 'kind');
  if (kind) {
    body.kind = kind;
  }
  out(await api('POST', `/_internal/v2/apps/${appId}/issues`, body));
}

async function issuesComment(appId: string, args: string[]) {
  const number = getPositional(args, 0);
  const flagBody = readBodyFlag(args);
  const commentBody =
    flagBody !== undefined ? flagBody : getPositional(args, 1);
  if (!number || !commentBody) {
    fatal(
      'Usage: mindstudio-prod issues comment <number> <body>   (or --body - to read stdin)',
    );
  }
  out(
    await api('POST', `/_internal/v2/apps/${appId}/issues/${number}/comments`, {
      body: commentBody,
      authorKind: 'agent',
    }),
  );
}

async function issuesClose(appId: string, args: string[]) {
  const number = getPositional(args, 0);
  if (!number) {
    fatal('Usage: mindstudio-prod issues close <number>');
  }
  out(
    await api('POST', `/_internal/v2/apps/${appId}/issues/${number}/update`, {
      status: 'closed',
      authorKind: 'agent',
    }),
  );
}

async function issuesReopen(appId: string, args: string[]) {
  const number = getPositional(args, 0);
  if (!number) {
    fatal('Usage: mindstudio-prod issues reopen <number>');
  }
  out(
    await api('POST', `/_internal/v2/apps/${appId}/issues/${number}/update`, {
      status: 'open',
      authorKind: 'agent',
    }),
  );
}

async function issuesEdit(appId: string, args: string[]) {
  const number = getPositional(args, 0);
  if (!number) {
    fatal(
      'Usage: mindstudio-prod issues edit <number> [--title <t>] [--body <t>|--body -] [--kind ...] [--status open|closed]',
    );
  }
  const body: Record<string, unknown> = {};
  const title = getFlag(args, 'title');
  const editBody = readBodyFlag(args);
  const kind = getFlag(args, 'kind');
  const status = getFlag(args, 'status');
  if (title !== undefined) {
    body.title = title;
  }
  if (editBody !== undefined) {
    body.body = editBody;
  }
  if (kind !== undefined) {
    body.kind = kind;
  }
  if (status !== undefined) {
    body.status = status;
  }
  if (Object.keys(body).length === 0) {
    fatal('Provide at least one of --title, --body, --kind, --status');
  }
  // Attribute any resulting timeline event (e.g. a status flip) to the agent.
  body.authorKind = 'agent';
  out(
    await api(
      'POST',
      `/_internal/v2/apps/${appId}/issues/${number}/update`,
      body,
    ),
  );
}

async function issuesDelete(appId: string, args: string[]) {
  const number = getPositional(args, 0);
  if (!number) {
    fatal('Usage: mindstudio-prod issues delete <number>');
  }
  out(await api('POST', `/_internal/v2/apps/${appId}/issues/${number}/delete`));
}

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

const HELP = `mindstudio-prod — Manage your production MindStudio app.

Usage: mindstudio-prod <command> <subcommand> [options]

Commands:
  requests    View request logs and metrics
  crashes     View frontend (browser) crash groups and events
  analytics   View traffic, top-N, geo, and AI-referral insights
  releases    View and monitor releases
  domains     Manage custom subdomain
  users       Manage app users and roles
  db          Query the production database
  secrets     Manage app secrets (env vars)
  methods     List and invoke methods
  data        Live database operations (e.g. lift-from-dev)
  issues      File and manage issues (bugs, ideas, tasks)

Run 'mindstudio-prod <command> --help' for details on each command.

All output is JSON. Configuration is read from environment variables
(MINDSTUDIO_API_KEY, API_BASE_URL) and mindstudio.json (appId).`;

const HELP_REQUESTS = `mindstudio-prod requests — View request logs and metrics.

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

const HELP_ANALYTICS = `mindstudio-prod analytics — Traffic, top-N, geo, and AI-referral insights.

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

const HELP_CRASHES = `mindstudio-prod crashes — View frontend (browser) crash groups and events.

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

const HELP_RELEASES = `mindstudio-prod releases — View and monitor releases.

Subcommands:
  list      List all releases
  get       Get full details of a specific release
  current   Get the currently live release
  status    Check release status (optionally poll until complete)

Usage:
  mindstudio-prod releases list
  mindstudio-prod releases get <releaseId>
  mindstudio-prod releases current
  mindstudio-prod releases status <releaseId> [--wait] [--timeout 120]

Examples:
  mindstudio-prod releases current
  mindstudio-prod releases status rel_abc123 --wait`;

const HELP_DOMAINS = `mindstudio-prod domains — Manage your app's domains.

Platform subdomain (e.g. my-app.madewithremy.com):
  get             Get current custom subdomain
  set             Set a custom subdomain
  check           Check if a subdomain is available

Custom domains (customer-owned hostnames, CNAME/A records):
  custom list                  List all custom hostnames on the app
  custom add <hostname>        Register a custom hostname (apex auto-pairs www)
  custom check <hostname>      Preflight a hostname before registering
  custom records <hostname>    Get the DNS records the customer must add
  custom status <hostname>     Get lifecycle status + any verification errors
  custom remove <hostname>     Remove a hostname (apex also removes paired www)
  custom retry <hostname>      Re-trigger validation (after customer fixes DNS)

Usage:
  mindstudio-prod domains get
  mindstudio-prod domains set my-app
  mindstudio-prod domains check my-app
  mindstudio-prod domains custom list
  mindstudio-prod domains custom add app.acme.com
  mindstudio-prod domains custom add acme.com
  mindstudio-prod domains custom check acme.com
  mindstudio-prod domains custom records app.acme.com
  mindstudio-prod domains custom status app.acme.com
  mindstudio-prod domains custom retry app.acme.com
  mindstudio-prod domains custom remove app.acme.com

Notes:
  - 'add' with an apex (e.g. acme.com) auto-creates the www.apex pair and
    returns both. 'remove' on an apex also removes its paired www.
  - 'list'/'records'/'status' read a CF-synced cache that can be up to ~5
    minutes stale. After the customer adds DNS, use 'retry' to force a
    synchronous re-check.
  - 'uiStatus' values: waiting_for_dns | issuing_ssl | live | action_needed | reconnecting.`;

const HELP_USERS = `mindstudio-prod users — Manage app users, roles, and API keys.

Subcommands:
  list              List app users (includes apiKeyMasked per user)
  set-role          Set a user's role
  create-api-key    Generate an API key for a user (returns full key once)
  revoke-api-key    Revoke a user's API key (immediate, in-flight requests will fail)

Usage:
  mindstudio-prod users list [--limit 50] [--offset 0]
  mindstudio-prod users set-role <userId> <role>
  mindstudio-prod users create-api-key <userId>
  mindstudio-prod users revoke-api-key <userId>

Examples:
  mindstudio-prod users list --limit 20
  mindstudio-prod users set-role usr_abc123 admin
  mindstudio-prod users create-api-key usr_abc123
  mindstudio-prod users revoke-api-key usr_abc123`;

const HELP_DB = `mindstudio-prod db — Query the production database.

Subcommands:
  query    Execute a SQL query against the live release's database
  tables   List all tables in the database

Usage:
  mindstudio-prod db <sql>
  mindstudio-prod db query <sql>
  mindstudio-prod db tables

Examples:
  mindstudio-prod db tables
  mindstudio-prod db "SELECT * FROM users LIMIT 10"
  mindstudio-prod db "INSERT INTO categories (name) VALUES ('Electronics')"
  mindstudio-prod db query "SELECT * FROM users LIMIT 10"`;

const HELP_SECRETS = `mindstudio-prod secrets — Manage app secrets (environment variables).

Subcommands:
  list     List all secret keys (values are not shown, only which environments have values)
  get      Get decrypted values for a secret
  set      Create or update a secret's value for dev and/or prod
  delete   Delete a secret entirely (both dev and prod values)

Usage:
  mindstudio-prod secrets list
  mindstudio-prod secrets get <KEY>
  mindstudio-prod secrets set <KEY> [--dev <value>] [--prod <value>] [--dev-clear] [--prod-clear]
  mindstudio-prod secrets delete <KEY>

The set command updates only the environments you specify:
  --dev <value>    Set the dev environment value
  --prod <value>   Set the prod environment value
  --dev-clear      Clear the dev environment value
  --prod-clear     Clear the prod environment value
  Omitted fields are left unchanged.

Note: Setting or deleting secrets stops all active sandboxes for this app.

Examples:
  mindstudio-prod secrets list
  mindstudio-prod secrets get STRIPE_SECRET_KEY
  mindstudio-prod secrets set STRIPE_SECRET_KEY --dev sk_test_abc --prod sk_live_xyz
  mindstudio-prod secrets set OPENAI_API_KEY --prod sk-abc123
  mindstudio-prod secrets set OLD_KEY --prod-clear
  mindstudio-prod secrets delete OLD_KEY`;

const HELP_DATA = `mindstudio-prod data — Live database operations.

Subcommands:
  lift-from-dev    Destructively replace live's databases with a snapshot of dev's.

Usage:
  mindstudio-prod data lift-from-dev --confirm

What lift-from-dev does:
  Copies every live-release database from its dev-release counterpart by name
  match. Wipes whatever was on live. Schema metadata for the live release is
  updated to match dev. Database/table IDs stay stable — clients don't need
  to reload anything. Writes an audit row tagged 'lift-dev-to-live'.

Critical constraints:
  - Whole-database overwrite, INCLUDING auth tables. If live has real signed-up
    users, this lift wipes them. Intended for first-publish / pre-launch data
    sync only. Do NOT run on a production app with real users.
  - All-or-nothing per database. No per-table lift. To preserve some tables
    while replacing others, use a method invoked via 'methods invoke --roles'.
  - --confirm is mandatory. The CLI refuses to run without it as a guardrail.
  - Wait ~10s after a final dev write before lifting (flush-loop race window).

Examples:
  mindstudio-prod data lift-from-dev --confirm`;

const HELP_METHODS = `mindstudio-prod methods — List and invoke methods.

Subcommands:
  list     List methods available in the live release
  invoke   Invoke a method with optional input

Usage:
  mindstudio-prod methods list
  mindstudio-prod methods invoke <methodId> [options]

Options for invoke:
  --input '<json>'       Method input (JSON object)
  --stream               Stream the response as SSE events
  --roles <a,b,c>        Run with these roles (comma-separated). Routes the
                         call through /invoke-as so role-gated methods can
                         be tested without spec edits.
  --user-id <userId>     Run as this user. Combine with --roles to set
                         identity AND role list explicitly. Either flag
                         alone also works.

Examples:
  mindstudio-prod methods list
  mindstudio-prod methods invoke mth_abc123
  mindstudio-prod methods invoke mth_abc123 --input '{"query":"hello"}'
  mindstudio-prod methods invoke mth_abc123 --input '{"query":"hello"}' --stream
  mindstudio-prod methods invoke mth_abc123 --roles admin
  mindstudio-prod methods invoke mth_abc123 --user-id user_abc --roles analyst,admin`;

const HELP_ISSUES = `mindstudio-prod issues — File and manage issues (bugs, ideas, tasks) for the app.

Subcommands:
  list      List issues (newest first)
  get       Get one issue + its comment thread
  create    File a new issue
  comment   Post a comment on an issue's thread
  close     Close an issue
  reopen    Reopen a closed issue
  edit      Edit an issue's title / body / kind / status
  delete    Delete an issue

Usage:
  mindstudio-prod issues list [--status open|closed] [--kind bug|idea|task] [--limit 50] [--cursor <c>]
  mindstudio-prod issues get <number>
  mindstudio-prod issues create <title> [--body <text>|--body -] [--kind bug|idea|task]
  mindstudio-prod issues comment <number> <body>          (or --body - to read stdin)
  mindstudio-prod issues close <number>
  mindstudio-prod issues reopen <number>
  mindstudio-prod issues edit <number> [--title <t>] [--body <t>|--body -] [--kind ...] [--status open|closed]
  mindstudio-prod issues delete <number>

Notes:
  - <number> is the friendly per-app issue number (e.g. 42), shown as 'number' in output.
  - Issues and comments filed via this CLI are authored as the agent (authorKind: "agent").
  - '--body -' reads the body from stdin — use it for long multi-line markdown.

Examples:
  mindstudio-prod issues list --status open --kind bug
  mindstudio-prod issues create "Checkout 500s on empty cart" --kind bug --body "Repro in comments"
  echo "Long markdown body..." | mindstudio-prod issues create "Refactor auth flow" --kind task --body -
  mindstudio-prod issues comment 42 "Fixed in the latest release."
  mindstudio-prod issues close 42`;

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const group = args[0];
  const sub = args[1];
  const rest = args.slice(2);

  // Top-level help
  if (!group || group === '--help' || group === '-h') {
    console.log(HELP);
    return;
  }

  // Subcommand help (before config validation so --help always works)
  const HELP_MAP: Record<string, string> = {
    requests: HELP_REQUESTS,
    crashes: HELP_CRASHES,
    analytics: HELP_ANALYTICS,
    releases: HELP_RELEASES,
    domains: HELP_DOMAINS,
    users: HELP_USERS,
    db: HELP_DB,
    secrets: HELP_SECRETS,
    methods: HELP_METHODS,
    data: HELP_DATA,
    issues: HELP_ISSUES,
  };
  if (!sub || sub === '--help' || sub === '-h') {
    const helpText = HELP_MAP[group];
    if (helpText) {
      console.log(helpText);
      return;
    }
  }

  // Validate config before running any command
  if (!API_KEY) {
    fatal('MINDSTUDIO_API_KEY environment variable is not set');
  }

  const appId = loadAppId();

  switch (group) {
    case 'requests':
      switch (sub) {
        case 'list':
          return requestsList(appId, rest);
        case 'get':
          return requestsGet(appId, rest);
        case 'stats':
          return requestsStats(appId, rest);
        default:
          fatal(
            `Unknown subcommand: requests ${sub}. Run 'mindstudio-prod requests --help'`,
          );
      }
      break;

    case 'crashes':
      switch (sub) {
        case 'list':
          return crashesList(appId, rest);
        case 'occurrences':
          return crashesOccurrences(appId, rest);
        case 'get':
          return crashesGet(appId, rest);
        case 'stats':
          return crashesStats(appId, rest);
        default:
          fatal(
            `Unknown subcommand: crashes ${sub}. Run 'mindstudio-prod crashes --help'`,
          );
      }
      break;

    case 'analytics':
      switch (sub) {
        case 'summary':
          return analyticsSummary(appId, rest);
        case 'timeseries':
          return analyticsTimeseries(appId, rest);
        case 'top':
          return analyticsTop(appId, rest);
        case 'events':
          return analyticsEvents(appId, rest);
        case 'map':
          return analyticsMap(appId, rest);
        case 'live':
          return analyticsLive(appId);
        case 'ai-sources':
          return analyticsAiSources(appId, rest);
        case 'crawlers':
          return analyticsCrawlers(appId, rest);
        default:
          fatal(
            `Unknown subcommand: analytics ${sub}. Run 'mindstudio-prod analytics --help'`,
          );
      }
      break;

    case 'releases':
      switch (sub) {
        case 'list':
          return releasesList(appId);
        case 'get':
          return releasesGet(appId, rest);
        case 'current':
          return releasesCurrent(appId);
        case 'status':
          return releasesStatus(appId, rest);
        default:
          fatal(
            `Unknown subcommand: releases ${sub}. Run 'mindstudio-prod releases --help'`,
          );
      }
      break;

    case 'domains':
      switch (sub) {
        case 'get':
          return domainsGet(appId);
        case 'set':
          return domainsSet(appId, rest);
        case 'check':
          return domainsCheck(appId, rest);
        case 'custom': {
          const action = rest[0];
          const customRest = rest.slice(1);
          switch (action) {
            case 'list':
              return customDomainsList(appId);
            case 'add':
              return customDomainsAdd(appId, customRest);
            case 'check':
              return customDomainsCheck(appId, customRest);
            case 'records':
              return customDomainsRecords(appId, customRest);
            case 'status':
              return customDomainsStatus(appId, customRest);
            case 'remove':
              return customDomainsRemove(appId, customRest);
            case 'retry':
              return customDomainsRetry(appId, customRest);
            default:
              fatal(
                `Unknown subcommand: domains custom ${action ?? ''}. Run 'mindstudio-prod domains --help'`,
              );
          }
          break;
        }
        default:
          fatal(
            `Unknown subcommand: domains ${sub}. Run 'mindstudio-prod domains --help'`,
          );
      }
      break;

    case 'users':
      switch (sub) {
        case 'list':
          return usersList(appId, rest);
        case 'set-role':
          return usersSetRole(appId, rest);
        case 'create-api-key':
          return usersCreateApiKey(appId, rest);
        case 'revoke-api-key':
          return usersRevokeApiKey(appId, rest);
        default:
          fatal(
            `Unknown subcommand: users ${sub}. Run 'mindstudio-prod users --help'`,
          );
      }
      break;

    case 'db':
      switch (sub) {
        case 'query':
          return dbQuery(appId, rest);
        case 'tables':
          return dbTables(appId);
        default:
          // Treat unknown subcommand as SQL: `mindstudio-prod db "SELECT ..."`
          return dbQuery(appId, [sub, ...rest]);
      }
      break;

    case 'secrets':
      switch (sub) {
        case 'list':
          return secretsList(appId);
        case 'get':
          return secretsGet(appId, rest);
        case 'set':
          return secretsSet(appId, rest);
        case 'delete':
          return secretsDelete(appId, rest);
        default:
          fatal(
            `Unknown subcommand: secrets ${sub}. Run 'mindstudio-prod secrets --help'`,
          );
      }
      break;

    case 'methods':
      switch (sub) {
        case 'list':
          return methodsList(appId);
        case 'invoke':
          return methodsInvoke(appId, rest);
        default:
          fatal(
            `Unknown subcommand: methods ${sub}. Run 'mindstudio-prod methods --help'`,
          );
      }
      break;

    case 'data':
      switch (sub) {
        case 'lift-from-dev':
          return dataLiftFromDev(appId, rest);
        default:
          fatal(
            `Unknown subcommand: data ${sub}. Run 'mindstudio-prod data --help'`,
          );
      }
      break;

    case 'issues':
      switch (sub) {
        case 'list':
          return issuesList(appId, rest);
        case 'get':
          return issuesGet(appId, rest);
        case 'create':
          return issuesCreate(appId, rest);
        case 'comment':
          return issuesComment(appId, rest);
        case 'close':
          return issuesClose(appId, rest);
        case 'reopen':
          return issuesReopen(appId, rest);
        case 'edit':
          return issuesEdit(appId, rest);
        case 'delete':
          return issuesDelete(appId, rest);
        default:
          fatal(
            `Unknown subcommand: issues ${sub}. Run 'mindstudio-prod issues --help'`,
          );
      }
      break;

    default:
      fatal(`Unknown command: ${group}. Run 'mindstudio-prod --help'`);
  }
}

main().catch((err) => {
  fatal(err.message ?? String(err));
});
