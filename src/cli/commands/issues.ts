import fs from 'node:fs';
import { type Args, type CommandSpec } from '../args.js';
import { api, seg } from '../api.js';
import { out } from '../output.js';
import type { Handler } from '../types.js';

export const issuesSpecs = {
  'issues list': {
    usage:
      'Usage: mindstudio-prod issues list [--status open|closed] [--kind bug|idea|task] [--limit 50] [--cursor <c>]',
    flags: {
      status: { type: 'string', param: 'status' },
      kind: { type: 'string', param: 'kind' },
      limit: { type: 'number', param: 'limit', min: 0 },
      cursor: { type: 'string', param: 'cursor' },
    },
  },
  'issues get': {
    usage: 'Usage: mindstudio-prod issues get <number>',
    positionals: [{ name: 'number', required: true }],
  },
  'issues create': {
    usage:
      'Usage: mindstudio-prod issues create <title> [--body <text>|--body -] [--kind bug|idea|task]',
    positionals: [{ name: 'title', required: true }],
    flags: { body: { type: 'string' }, kind: { type: 'string' } },
  },
  'issues comment': {
    usage:
      'Usage: mindstudio-prod issues comment <number> <body>   (or --body - to read stdin)',
    positionals: [{ name: 'number', required: true }, { name: 'body' }],
    flags: { body: { type: 'string' } },
    requireAnyOf: {
      flags: ['body'],
      positionals: ['body'],
      message: 'A comment body is required.',
    },
  },
  'issues close': {
    usage: 'Usage: mindstudio-prod issues close <number>',
    positionals: [{ name: 'number', required: true }],
  },
  'issues reopen': {
    usage: 'Usage: mindstudio-prod issues reopen <number>',
    positionals: [{ name: 'number', required: true }],
  },
  'issues edit': {
    usage:
      'Usage: mindstudio-prod issues edit <number> [--title <t>] [--body <t>|--body -] [--kind ...] [--status open|closed]',
    positionals: [{ name: 'number', required: true }],
    flags: {
      title: { type: 'string' },
      body: { type: 'string' },
      kind: { type: 'string' },
      status: { type: 'string' },
    },
    requireAnyOf: {
      flags: ['title', 'body', 'kind', 'status'],
      message: 'Provide at least one of --title, --body, --kind, --status',
    },
  },
  'issues delete': {
    usage: 'Usage: mindstudio-prod issues delete <number>',
    positionals: [{ name: 'number', required: true }],
  },
} satisfies Record<string, CommandSpec>;

// Resolve a --body value: `--body -` reads stdin (for long multi-line
// markdown remy generates); `--body <text>` uses the literal; absent → undefined.
function readBodyFlag(a: Args): string | undefined {
  const val = a.str('body');
  if (val === undefined) {
    return undefined;
  }
  if (val === '-') {
    return fs.readFileSync(0, 'utf-8');
  }
  return val;
}
async function issuesList(appId: string, a: Args) {
  out(await api('GET', `/_internal/v2/apps/${appId}/issues${a.query()}`));
}
async function issuesGet(appId: string, a: Args) {
  const number = a.req('number');
  out(await api('GET', `/_internal/v2/apps/${appId}/issues/${seg(number)}`));
}
async function issuesCreate(appId: string, a: Args) {
  const title = a.req('title');
  // Everything the CLI files is authored as the agent.
  const body: Record<string, unknown> = { title, authorKind: 'agent' };
  const issueBody = readBodyFlag(a);
  if (issueBody !== undefined) {
    body.body = issueBody;
  }
  const kind = a.str('kind');
  if (kind) {
    body.kind = kind;
  }
  out(await api('POST', `/_internal/v2/apps/${appId}/issues`, body));
}
async function issuesComment(appId: string, a: Args) {
  const number = a.req('number');
  const commentBody = readBodyFlag(a) ?? a.req('body');
  out(
    await api(
      'POST',
      `/_internal/v2/apps/${appId}/issues/${seg(number)}/comments`,
      {
        body: commentBody,
        authorKind: 'agent',
      },
    ),
  );
}
async function issuesClose(appId: string, a: Args) {
  const number = a.req('number');
  out(
    await api(
      'POST',
      `/_internal/v2/apps/${appId}/issues/${seg(number)}/update`,
      {
        status: 'closed',
        authorKind: 'agent',
      },
    ),
  );
}
async function issuesReopen(appId: string, a: Args) {
  const number = a.req('number');
  out(
    await api(
      'POST',
      `/_internal/v2/apps/${appId}/issues/${seg(number)}/update`,
      {
        status: 'open',
        authorKind: 'agent',
      },
    ),
  );
}
async function issuesEdit(appId: string, a: Args) {
  const number = a.req('number');
  const body: Record<string, unknown> = {};
  const title = a.str('title');
  const editBody = readBodyFlag(a);
  const kind = a.str('kind');
  const status = a.str('status');
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
  // Attribute any resulting timeline event (e.g. a status flip) to the agent.
  body.authorKind = 'agent';
  out(
    await api(
      'POST',
      `/_internal/v2/apps/${appId}/issues/${seg(number)}/update`,
      body,
    ),
  );
}
async function issuesDelete(appId: string, a: Args) {
  const number = a.req('number');
  out(
    await api(
      'POST',
      `/_internal/v2/apps/${appId}/issues/${seg(number)}/delete`,
    ),
  );
}

export const issuesHandlers = {
  'issues list': issuesList,
  'issues get': issuesGet,
  'issues create': issuesCreate,
  'issues comment': issuesComment,
  'issues close': issuesClose,
  'issues reopen': issuesReopen,
  'issues edit': issuesEdit,
  'issues delete': issuesDelete,
} satisfies Record<keyof typeof issuesSpecs, Handler>;

export const issuesHelp = `mindstudio-prod issues — File and manage issues (bugs, ideas, tasks) for the app.

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
