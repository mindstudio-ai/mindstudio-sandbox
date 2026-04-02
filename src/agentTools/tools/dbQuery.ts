import { createLogger } from '../../logger.js';
import type { ExternalToolHandler } from '../types.js';

const log = createLogger('tool:dbQuery');

export const dbQueryTool: ExternalToolHandler = {
  handle(id, input, ctx) {
    const sql = input.sql as string;
    if (!sql) {
      ctx.sendToolResult(id, 'error: missing sql');
      return true;
    }
    log.info('Agent running db query', { toolCallId: id });
    ctx
      .sendTunnelCommand('db-query', { sql }, 30_000)
      .then((result) => ctx.sendToolResult(id, JSON.stringify(result)));
    return true;
  },
};
