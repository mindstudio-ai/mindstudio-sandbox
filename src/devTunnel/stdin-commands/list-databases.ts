import { CommandError } from './types.ts';
import type { CommandContext } from './types.ts';
import type { TunnelCommandResult } from '../protocol.ts';

export async function handleListDatabases(
  ctx: CommandContext,
  _cmd: Record<string, unknown>,
): Promise<TunnelCommandResult['list-databases']> {
  if (!ctx.state.runner) {
    throw new CommandError('No active session', 'NO_SESSION');
  }
  const session = ctx.state.runner.getSession();
  if (!session) {
    throw new CommandError('No active session', 'NO_SESSION');
  }

  return {
    success: true,
    databases: session.databases.map((db) => ({
      id: db.id,
      name: db.name,
      tables: db.tables.map((t) => ({ name: t.name })),
    })),
  };
}
