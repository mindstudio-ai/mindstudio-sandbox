/**
 * Turning argv into a command: which group/subcommand was asked for, or which
 * help text to print instead.
 *
 * Kept separate from the entry point so `prod.ts` stays a wiring file, and
 * separate from the slices so that adding a command group means touching only
 * its own file plus the registry.
 */

import { GROUP_HELP, SPECS, type CommandKey } from './commands/index.js';

const HELP = `mindstudio-prod — Manage your production MindStudio app.

Usage: mindstudio-prod <command> <subcommand> [options]

Commands:
  requests    View request logs and metrics
  crashes     View frontend (browser) crash groups and events
  analytics   View traffic, top-N, geo, and AI-referral insights
  releases    View and monitor releases
  diagnostics View the post-deploy Lighthouse audit (scores, issues, raw report)
  domains     Manage custom subdomain
  users       Manage app users and roles
  db          Query the production database
  secrets     Manage app secrets (env vars)
  methods     List and invoke methods
  data        Sync databases between dev and live (lift-from-dev / lift-from-live)
  issues      File and manage issues (bugs, ideas, tasks)
  prerender   Manage + verify prerendered snapshots served to bots/crawlers
  files       Upload + manage files on the app's CDN (build-time)
  datasources Build and query searchable document corpora (RAG)
  voice       Phone numbers, voice call log + transcripts, voice policy settings
  jewels      Monitor jewel shadowing; review + approve the proposal queue

Run 'mindstudio-prod <command> --help' for details on each command.

Unknown flags are rejected rather than ignored. For any flag value beginning
with a dash, use --name=value; to pass a positional beginning with a dash, put
-- before it.

All output is JSON. Configuration is read from environment variables
(MINDSTUDIO_API_KEY, API_BASE_URL) and mindstudio.json (appId).`;

const GROUPS = [
  'requests',
  'crashes',
  'analytics',
  'releases',
  'diagnostics',
  'domains',
  'users',
  'db',
  'secrets',
  'methods',
  'data',
  'issues',
  'prerender',
  'files',
  'datasources',
  'voice',
  'jewels',
] as const;

type Route = { key: CommandKey; argv: string[] };

const KEYS = new Set<string>(Object.keys(SPECS));

/**
 * Resolve argv to a command key plus its remaining arguments.
 *
 * Longest path first so the three-token `domains custom add` wins over any
 * two-token prefix. Returns an error string rather than throwing so main() can
 * report it before touching config — an unknown command must say it's unknown,
 * not complain about a missing API key.
 */
export function resolveRoute(argv: string[]): Route | { error: string } {
  const [group, sub, action] = argv;

  if (!group || !(GROUPS as readonly string[]).includes(group)) {
    return { error: `Unknown command: ${group}. Run 'mindstudio-prod --help'` };
  }

  const three = `${group} ${sub} ${action}`;
  if (sub && action && KEYS.has(three)) {
    return { key: three as CommandKey, argv: argv.slice(3) };
  }

  const two = `${group} ${sub}`;
  if (sub && KEYS.has(two)) {
    return { key: two as CommandKey, argv: argv.slice(2) };
  }

  // `domains custom <unknown>` has its own message (and `custom` alone lands here).
  if (group === 'domains' && sub === 'custom') {
    return {
      error: `Unknown subcommand: domains custom ${action ?? ''}. Run 'mindstudio-prod domains --help'`,
    };
  }

  // An unrecognised `db` subcommand is SQL: `mindstudio-prod db "SELECT ..."`.
  if (group === 'db' && sub) {
    return { key: 'db query', argv: argv.slice(1) };
  }

  return {
    error: `Unknown subcommand: ${group} ${sub ?? ''}. Run 'mindstudio-prod ${group} --help'`,
  };
}

/**
 * Pick the help text for an invocation, or undefined to run the command.
 *
 * `--help` is honored at any depth so nested groups work (`domains custom
 * --help` used to fall through and die on config), except under `db`, where the
 * payload is raw SQL that could legitimately contain the token.
 */
export function resolveHelp(argv: string[]): string | undefined {
  const group = argv[0];
  if (!group || group === '--help' || group === '-h') {
    return HELP;
  }
  const groupHelp = GROUP_HELP[group];
  if (!groupHelp) {
    return undefined; // unknown group — let routing report it
  }
  if (argv.length === 1) {
    return groupHelp;
  }
  const scan =
    group === 'db' ? argv.slice(1, argv[1] === 'query' ? 3 : 2) : argv.slice(1);
  return scan.some((t) => t === '--help' || t === '-h') ? groupHelp : undefined;
}
