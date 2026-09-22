import type { CommandContext } from './types.ts';
import type { TunnelCommandResult } from '../protocol.ts';

export async function handleTableFileChanged(
  ctx: CommandContext,
): Promise<TunnelCommandResult['table-file-changed']> {
  await ctx.lifecycle.onTableFileChanged();
  return { success: true };
}
