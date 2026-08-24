import { createLogger } from '../../logger.js';
import type { ExternalToolHandler } from '../types.js';

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
    const params: Record<string, unknown> = { method };
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
