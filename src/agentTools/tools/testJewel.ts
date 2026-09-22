import { createLogger } from '../../logger.ts';
import type { ExternalToolHandler } from '../types.ts';
import type { TunnelCommandParams } from '../../devTunnel/protocol.ts';

const log = createLogger('tool:testJewel');

export const testJewelTool: ExternalToolHandler = {
  handle(id, input, ctx) {
    const method = input.method as string;
    if (!method) {
      ctx.sendToolResult(
        id,
        JSON.stringify({ success: false, error: 'missing method' }),
      );
      return true;
    }
    // `humanInput` and `subject` stay `unknown` in the protocol — they are the
    // jewel's own input shape, which only the app knows — so passing them
    // through unnarrowed is correct here, unlike `run-method`'s `roles`.
    const params: TunnelCommandParams['test-jewel'] = { method };
    if (input.humanInput !== undefined) {
      params.humanInput = input.humanInput;
    }
    if (input.subject !== undefined) {
      params.subject = input.subject;
    }
    log.info('Agent testing jewel', { toolCallId: id, method });
    ctx
      // 30 min — the tunnel executor's own per-execution cap (matching the
      // prod sandbox worker's HANDLER_TIMEOUT): jewels are task loops.
      .sendTunnelCommand('test-jewel', params, 1_800_000)
      .then((result) => ctx.sendToolResult(id, JSON.stringify(result)));
    return true;
  },
};
