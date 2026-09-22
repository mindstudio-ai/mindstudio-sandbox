import { createLogger } from '../../logger.ts';
import type { ExternalToolHandler } from '../types.ts';
import type { TunnelCommandParams } from '../../devTunnel/protocol.ts';

const log = createLogger('tool:runMethod');

export const runMethodTool: ExternalToolHandler = {
  handle(id, input, ctx) {
    const method = input.method as string;
    if (!method) {
      ctx.sendToolResult(
        id,
        JSON.stringify({ success: false, error: 'missing method' }),
      );
      return true;
    }
    const methodInput = (input.input as Record<string, unknown>) ?? {};
    const params: TunnelCommandParams['run-method'] = {
      method,
      input: methodInput,
    };
    // Narrowed rather than forwarded. This is model-authored input and `roles`
    // decides which identity the method runs as; the tunnel's handler defends
    // itself too, but it should not be the only thing that does.
    if (Array.isArray(input.roles)) {
      params.roles = input.roles.filter(
        (r): r is string => typeof r === 'string',
      );
    }
    if (typeof input.userId === 'string') {
      params.userId = input.userId;
    }
    log.info('Agent running method', { toolCallId: id, method });
    ctx
      // 30 min — the tunnel executor's own per-execution cap (matching the
      // prod sandbox worker's HANDLER_TIMEOUT): methods can be task loops.
      .sendTunnelCommand('run-method', params, 1_800_000)
      .then((result) => ctx.sendToolResult(id, JSON.stringify(result)));
    return true;
  },
};
