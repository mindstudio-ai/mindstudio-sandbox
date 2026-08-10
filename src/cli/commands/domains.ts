import { type Args, type CommandSpec } from '../args.js';
import { api, seg } from '../api.js';
import { fatal } from '../errors.js';
import { out } from '../output.js';
import type { Handler } from '../types.js';

export const domainsSpecs = {
  'domains get': {
    usage: 'Usage: mindstudio-prod domains get',
  },
  'domains set': {
    usage: 'Usage: mindstudio-prod domains set <subdomain>',
    positionals: [{ name: 'subdomain', required: true }],
  },
  'domains check': {
    usage: 'Usage: mindstudio-prod domains check <subdomain>',
    positionals: [{ name: 'subdomain', required: true }],
  },
  'domains custom list': {
    usage: 'Usage: mindstudio-prod domains custom list',
  },
  'domains custom add': {
    usage: 'Usage: mindstudio-prod domains custom add <hostname>',
    positionals: [{ name: 'hostname', required: true }],
  },
  'domains custom check': {
    usage: 'Usage: mindstudio-prod domains custom check <hostname>',
    positionals: [{ name: 'hostname', required: true }],
  },
  'domains custom records': {
    usage: 'Usage: mindstudio-prod domains custom records <hostname>',
    positionals: [{ name: 'hostname', required: true }],
  },
  'domains custom status': {
    usage: 'Usage: mindstudio-prod domains custom status <hostname>',
    positionals: [{ name: 'hostname', required: true }],
  },
  'domains custom remove': {
    usage: 'Usage: mindstudio-prod domains custom remove <hostname>',
    positionals: [{ name: 'hostname', required: true }],
  },
  'domains custom retry': {
    usage: 'Usage: mindstudio-prod domains custom retry <hostname>',
    positionals: [{ name: 'hostname', required: true }],
  },
} satisfies Record<string, CommandSpec>;

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
async function domainsGet(appId: string) {
  out(
    await api('GET', `/_internal/v2/apps/${appId}/settings/custom-subdomain`),
  );
}
async function domainsSet(appId: string, a: Args) {
  const subdomain = a.req('subdomain');
  out(
    await api('POST', `/_internal/v2/apps/${appId}/settings/custom-subdomain`, {
      subdomain,
    }),
  );
}
async function domainsCheck(appId: string, a: Args) {
  const subdomain = a.req('subdomain');
  out(
    await api(
      'POST',
      `/_internal/v2/apps/${appId}/settings/custom-subdomain/check-availability`,
      { subdomain },
    ),
  );
}
async function customDomainsList(appId: string) {
  out(await api('GET', `/_internal/v2/apps/${appId}/settings/custom-domains`));
}
async function customDomainsAdd(appId: string, a: Args) {
  const hostname = a.req('hostname');
  out(
    await api('POST', `/_internal/v2/apps/${appId}/settings/custom-domains`, {
      hostname,
    }),
  );
}
async function customDomainsCheck(appId: string, a: Args) {
  const hostname = a.req('hostname');
  out(
    await api(
      'POST',
      `/_internal/v2/apps/${appId}/settings/custom-domains/check-domain`,
      { hostname },
    ),
  );
}
async function customDomainsRecords(appId: string, a: Args) {
  const hostname = a.req('hostname');
  const { entry } = await findHostnameId(appId, hostname);
  out({
    hostname: entry.hostname,
    isApex: entry.isApex,
    dnsInstructions: entry.dnsInstructions,
  });
}
async function customDomainsStatus(appId: string, a: Args) {
  const hostname = a.req('hostname');
  const { entry } = await findHostnameId(appId, hostname);
  out({
    hostname: entry.hostname,
    uiStatus: entry.uiStatus,
    verificationErrors: entry.verificationErrors ?? null,
    cfStatus: entry.cfStatus,
    cfSslStatus: entry.cfSslStatus,
  });
}
async function customDomainsRemove(appId: string, a: Args) {
  const hostname = a.req('hostname');
  const { id } = await findHostnameId(appId, hostname);
  out(
    await api(
      'POST',
      `/_internal/v2/apps/${appId}/settings/custom-domains/${seg(id)}/delete`,
    ),
  );
}
async function customDomainsRetry(appId: string, a: Args) {
  const hostname = a.req('hostname');
  const { id } = await findHostnameId(appId, hostname);
  out(
    await api(
      'POST',
      `/_internal/v2/apps/${appId}/settings/custom-domains/${seg(id)}/retry`,
    ),
  );
}

export const domainsHandlers = {
  'domains get': domainsGet,
  'domains set': domainsSet,
  'domains check': domainsCheck,
  'domains custom list': customDomainsList,
  'domains custom add': customDomainsAdd,
  'domains custom check': customDomainsCheck,
  'domains custom records': customDomainsRecords,
  'domains custom status': customDomainsStatus,
  'domains custom remove': customDomainsRemove,
  'domains custom retry': customDomainsRetry,
} satisfies Record<keyof typeof domainsSpecs, Handler>;

export const domainsHelp = `mindstudio-prod domains — Manage your app's domains.

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
