import { createLogger } from '../../logger.js';
import type { ExternalToolHandler } from '../types.js';

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
    const params: Record<string, unknown> = { method, input: methodInput };
    if (input.roles) {
      params.roles = input.roles;
    }
    if (input.userId) {
      params.userId = input.userId;
    }
    log.info('Agent running method', { toolCallId: id, method });
    ctx
      .sendTunnelCommand('run-method', params, 300_000)
      .then((result) => ctx.sendToolResult(id, JSON.stringify(result)));
    return true;
  },
};
