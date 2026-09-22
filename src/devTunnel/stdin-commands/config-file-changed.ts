import { CommandError } from './types.ts';
import type { CommandContext } from './types.ts';
import type { TunnelCommandParams, TunnelCommandResult } from '../protocol.ts';

/**
 * Resolves once the session has acted on the change — hot-applied it,
 * restarted, or declined because the new manifest is invalid — so the result
 * the C&C receives is the truth about what happened, as with `restart-worker`.
 */
export async function handleConfigFileChanged(
  ctx: CommandContext,
  cmd: Partial<TunnelCommandParams['config-file-changed']>,
): Promise<TunnelCommandResult['config-file-changed']> {
  if (typeof cmd.path !== 'string' || !cmd.path) {
    throw new CommandError(
      'config-file-changed requires the absolute `path` that changed',
      'INVALID_INPUT',
    );
  }
  await ctx.lifecycle.onConfigFileChanged(cmd.path);
  return { success: true };
}
