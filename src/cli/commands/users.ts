import { PAGINATION, type Args, type CommandSpec } from '../args.js';
import { api, seg } from '../api.js';
import { out } from '../output.js';
import type { Handler } from '../types.js';

export const usersSpecs = {
  'users list': {
    usage: 'Usage: mindstudio-prod users list [--limit 50] [--offset 0]',
    flags: { ...PAGINATION },
  },
  'users set-role': {
    usage: 'Usage: mindstudio-prod users set-role <userId> <role>',
    positionals: [
      { name: 'userId', required: true },
      { name: 'role', required: true },
    ],
  },
  'users create-api-key': {
    usage: 'Usage: mindstudio-prod users create-api-key <userId>',
    positionals: [{ name: 'userId', required: true }],
  },
  'users revoke-api-key': {
    usage: 'Usage: mindstudio-prod users revoke-api-key <userId>',
    positionals: [{ name: 'userId', required: true }],
  },
} satisfies Record<string, CommandSpec>;

async function usersList(appId: string, a: Args) {
  out(await api('GET', `/_internal/v2/apps/${appId}/users${a.query()}`));
}
async function usersSetRole(appId: string, a: Args) {
  const userId = a.req('userId');
  const role = a.req('role');
  out(
    await api(
      'POST',
      `/_internal/v2/apps/${appId}/users/${seg(userId)}/roles`,
      {
        roles: [role],
      },
    ),
  );
}
async function usersCreateApiKey(appId: string, a: Args) {
  const userId = a.req('userId');
  out(
    await api(
      'POST',
      `/_internal/v2/apps/${appId}/users/${seg(userId)}/api-key`,
    ),
  );
}
async function usersRevokeApiKey(appId: string, a: Args) {
  const userId = a.req('userId');
  out(
    await api(
      'DELETE',
      `/_internal/v2/apps/${appId}/users/${seg(userId)}/api-key`,
    ),
  );
}

export const usersHandlers = {
  'users list': usersList,
  'users set-role': usersSetRole,
  'users create-api-key': usersCreateApiKey,
  'users revoke-api-key': usersRevokeApiKey,
} satisfies Record<keyof typeof usersSpecs, Handler>;

export const usersHelp = `mindstudio-prod users — Manage app users, roles, and API keys.

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
