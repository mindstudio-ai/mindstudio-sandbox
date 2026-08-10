import { type Args, type CommandSpec } from '../args.js';
import { api, seg } from '../api.js';
import { fatal } from '../errors.js';
import { out } from '../output.js';
import type { Handler } from '../types.js';

export const secretsSpecs = {
  'secrets list': {
    usage: 'Usage: mindstudio-prod secrets list',
  },
  'secrets get': {
    usage: 'Usage: mindstudio-prod secrets get <KEY>',
    positionals: [{ name: 'key', required: true }],
  },
  'secrets set': {
    usage:
      'Usage: mindstudio-prod secrets set <KEY> [--dev <value>] [--prod <value>] [--dev-clear] [--prod-clear]',
    positionals: [{ name: 'key', required: true }],
    flags: {
      dev: { type: 'string' },
      prod: { type: 'string' },
      'dev-clear': { type: 'boolean' },
      'prod-clear': { type: 'boolean' },
    },
    requireAnyOf: {
      flags: ['dev', 'prod', 'dev-clear', 'prod-clear'],
      message:
        'At least one of --dev <value>, --prod <value>, --dev-clear, or --prod-clear is required',
    },
  },
  'secrets delete': {
    usage: 'Usage: mindstudio-prod secrets delete <KEY>',
    positionals: [{ name: 'key', required: true }],
  },
} satisfies Record<string, CommandSpec>;

async function secretsList(appId: string) {
  out(await api('GET', `/_internal/v2/apps/${appId}/secrets`));
}
async function secretsGet(appId: string, a: Args) {
  const key = a.req('key');
  out(await api('GET', `/_internal/v2/apps/${appId}/secrets/${seg(key)}`));
}
async function secretsSet(appId: string, a: Args) {
  const key = a.req('key');

  const body: Record<string, unknown> = {};
  const dev = a.str('dev');
  const prod = a.str('prod');
  const devClear = a.bool('dev-clear');
  const prodClear = a.bool('prod-clear');

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

  out(
    await api('PUT', `/_internal/v2/apps/${appId}/secrets/${seg(key)}`, body),
  );
}
async function secretsDelete(appId: string, a: Args) {
  const key = a.req('key');
  out(await api('DELETE', `/_internal/v2/apps/${appId}/secrets/${seg(key)}`));
}

export const secretsHandlers = {
  'secrets list': secretsList,
  'secrets get': secretsGet,
  'secrets set': secretsSet,
  'secrets delete': secretsDelete,
} satisfies Record<keyof typeof secretsSpecs, Handler>;

export const secretsHelp = `mindstudio-prod secrets — Manage app secrets (environment variables).

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

Examples:
  mindstudio-prod secrets list
  mindstudio-prod secrets get STRIPE_SECRET_KEY
  mindstudio-prod secrets set STRIPE_SECRET_KEY --dev sk_test_abc --prod sk_live_xyz
  mindstudio-prod secrets set OPENAI_API_KEY --prod sk-abc123
  mindstudio-prod secrets set OLD_KEY --prod-clear
  mindstudio-prod secrets delete OLD_KEY

Notes:
  - If a value starts with a dash, use the '=' form so it isn't read as a flag:
    mindstudio-prod secrets set KEY --prod=-abc123`;
