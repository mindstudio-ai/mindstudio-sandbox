import { type Args, type CommandSpec } from '../args.js';
import { api } from '../api.js';
import { out } from '../output.js';
import type { Handler } from '../types.js';

export const dbSpecs = {
  'db query': {
    // raw: SQL may legally begin with a `--` comment, which strict flag parsing
    // would reject as an unknown option. This command takes no flags at all.
    usage: 'Usage: mindstudio-prod db query <sql>',
    raw: true,
    positionals: [{ name: 'sql', required: true }],
  },
  'db tables': {
    usage: 'Usage: mindstudio-prod db tables',
  },
} satisfies Record<string, CommandSpec>;

async function dbQuery(appId: string, a: Args) {
  const sql = a.req('sql');
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

export const dbHandlers = {
  'db query': dbQuery,
  'db tables': dbTables,
} satisfies Record<keyof typeof dbSpecs, Handler>;

export const dbHelp = `mindstudio-prod db — Query the production database.

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
  mindstudio-prod db query "SELECT * FROM users LIMIT 10"

Notes:
  - SQL is taken verbatim: this is the one command that does not parse flags, so
    a statement may safely begin with a '--' comment. Always quote the SQL.`;
