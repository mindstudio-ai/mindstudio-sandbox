import { createLogger } from '../../logger.js';
import type { ExternalToolHandler } from '../types.js';

const log = createLogger('tool:browserCommand');

export const browserCommandTool: ExternalToolHandler = {
  handle(id, input, ctx) {
    const steps = (input.steps as unknown[]) ?? [];
    log.info('Agent running browser command', {
      toolCallId: id,
      steps: steps.length,
    });
    ctx
      .sendTunnelCommand('browser', { steps }, 120_000)
      .then((result) => ctx.sendToolResult(id, JSON.stringify(result)));
    return true;
  },
};
