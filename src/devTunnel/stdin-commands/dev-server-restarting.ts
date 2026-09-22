import { CommandError } from './types.ts';
import type { CommandContext } from './types.ts';
import type { TunnelCommandResult } from '../protocol.ts';

export async function handleDevServerRestarting(
  ctx: CommandContext,
): Promise<TunnelCommandResult['dev-server-restarting']> {
  if (!ctx.state.proxy) {
    throw new CommandError('No active proxy', 'NO_BROWSER');
  }

  ctx.state.proxy.markUpstreamDown();
  return { success: true };
}
