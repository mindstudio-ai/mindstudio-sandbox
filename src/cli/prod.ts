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
      'Usage: mindstudio-prod methods invoke <methodId> [--input \'{"key":"value"}\'] [--stream]',
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

  const stream = hasFlag(args, 'stream');
  const apiPath = `/_internal/v2/apps/${appId}/methods/${methodId}/invoke`;

  if (stream) {
    await apiStream(apiPath, { input, stream: true });
  } else {
    out(await api('POST', apiPath, { input }));
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
  methods     List and invoke methods

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

const HELP_DOMAINS = `mindstudio-prod domains — Manage custom subdomain.

Subcommands:
  get     Get current custom subdomain
  set     Set a custom subdomain
  check   Check if a subdomain is available

Usage:
  mindstudio-prod domains get
  mindstudio-prod domains set my-app
  mindstudio-prod domains check my-app`;

const HELP_USERS = `mindstudio-prod users — Manage app users and roles.

Subcommands:
  list       List app users
  set-role   Set a user's role

Usage:
  mindstudio-prod users list [--limit 50] [--offset 0]
  mindstudio-prod users set-role <userId> <role>

Examples:
  mindstudio-prod users list --limit 20
  mindstudio-prod users set-role usr_abc123 admin`;

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

const HELP_METHODS = `mindstudio-prod methods — List and invoke methods.

Subcommands:
  list     List methods available in the live release
  invoke   Invoke a method with optional input

Usage:
  mindstudio-prod methods list
  mindstudio-prod methods invoke <methodId> [--input '{"key":"value"}'] [--stream]

Examples:
  mindstudio-prod methods list
  mindstudio-prod methods invoke mth_abc123
  mindstudio-prod methods invoke mth_abc123 --input '{"query":"hello"}'
  mindstudio-prod methods invoke mth_abc123 --input '{"query":"hello"}' --stream`;

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
    methods: HELP_METHODS,
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

    default:
      fatal(`Unknown command: ${group}. Run 'mindstudio-prod --help'`);
  }
}

main().catch((err) => {
  fatal(err.message ?? String(err));
});
