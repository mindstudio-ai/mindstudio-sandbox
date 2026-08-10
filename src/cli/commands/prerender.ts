import { type Args, type CommandSpec } from '../args.js';
import { REQUEST_TIMEOUT_MS, api, fetchWithTimeout } from '../api.js';
import { API_BASE } from '../config.js';
import { out } from '../output.js';
import type { Handler } from '../types.js';

export const prerenderSpecs = {
  'prerender invalidate': {
    usage:
      'Usage: mindstudio-prod prerender invalidate <path...>   (or --all to purge every snapshot)',
    positionals: [{ name: 'path', variadic: true }],
    flags: { all: { type: 'boolean' } },
    requireAnyOf: {
      flags: ['all'],
      positionals: ['path'],
      message: 'Provide at least one path, or --all to purge every snapshot.',
    },
  },
  'prerender get': {
    usage: 'Usage: mindstudio-prod prerender get <path>',
    positionals: [{ name: 'path', required: true }],
  },
} satisfies Record<string, CommandSpec>;

async function prerenderInvalidate(appId: string, a: Args) {
  const body: Record<string, unknown> = {};
  if (!a.bool('all')) {
    body.paths = a.rest('path');
  }
  out(
    await api('POST', `/_internal/v2/apps/${appId}/prerender/invalidate`, body),
  );
}
// Verify what a crawler actually gets: fetch the app's public URL with a bot
// User-Agent so the origin serves the prerender snapshot branch. Not an authed
// api() call — it hits the public serve path exactly as a crawler would. A cold
// path returns the live SPA (and triggers a render); re-run to see the snapshot.
async function prerenderGet(appId: string, a: Args) {
  const rawPath = a.req('path');
  const normalized = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
  const isDev = !API_BASE.includes('api.mindstudio.ai');
  const host = `${appId}${isDev ? '-dev' : ''}.madewithremy.com`;
  const url = `https://${host}${normalized}`;
  const res = await fetchWithTimeout(
    url,
    {
      headers: {
        'User-Agent': 'Twitterbot/1.0 (+mindstudio-prod prerender verify)',
      },
    },
    REQUEST_TIMEOUT_MS,
    `Prerender fetch ${url}`,
  );
  const html = await res.text();
  out({ url, status: res.status, html });
}

export const prerenderHandlers = {
  'prerender invalidate': prerenderInvalidate,
  'prerender get': prerenderGet,
} satisfies Record<keyof typeof prerenderSpecs, Handler>;

export const prerenderHelp = `mindstudio-prod prerender — Manage prerendered snapshots served to bots/crawlers.

Subcommands:
  invalidate   Purge cached snapshot(s) so crawlers get a fresh render next visit
  get          Fetch a path as a crawler (bot UA) to verify the snapshot

Usage:
  mindstudio-prod prerender invalidate <path...>     Purge specific paths
  mindstudio-prod prerender invalidate --all         Purge every snapshot for the app
  mindstudio-prod prerender get <path>               Print { url, status, html } as a crawler sees it

Notes:
  - 'get' hits the public serve path with a bot User-Agent. A warm path returns the
    snapshot; a cold path returns the live SPA and triggers a render — re-run to see it.
  - Invalidation targets the current LIVE release; a deploy already invalidates on its own.

Examples:
  mindstudio-prod prerender invalidate /u/abc123
  mindstudio-prod prerender invalidate --all
  mindstudio-prod prerender get /u/abc123`;
