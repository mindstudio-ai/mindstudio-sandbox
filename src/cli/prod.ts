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
// Help text
// ---------------------------------------------------------------------------

const HELP = `mindstudio-prod — Manage your production MindStudio app.

Usage: mindstudio-prod <command> <subcommand> [options]

Commands:
  requests    View request logs and metrics
  releases    View and monitor releases
  domains     Manage custom subdomain
  users       Manage app users and roles
  db          Query the production database
  secrets     Manage app secrets (env vars)
  methods     List and invoke methods
  data        Live database operations (e.g. lift-from-dev)

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
    releases: HELP_RELEASES,
    domains: HELP_DOMAINS,
    users: HELP_USERS,
    db: HELP_DB,
    secrets: HELP_SECRETS,
    methods: HELP_METHODS,
    data: HELP_DATA,
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

    default:
      fatal(`Unknown command: ${group}. Run 'mindstudio-prod --help'`);
  }
}

main().catch((err) => {
  fatal(err.message ?? String(err));
});
