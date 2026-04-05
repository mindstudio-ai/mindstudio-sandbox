import { createLogger } from '../../logger.js';
import type { ExternalToolHandler } from '../types.js';

const log = createLogger('tool:runScenario');

export const runScenarioTool: ExternalToolHandler = {
  handle(id, input, ctx) {
    const scenarioId = input.scenarioId as string;
    if (!scenarioId) {
      ctx.sendToolResult(id, 'error: missing scenarioId');
      return true;
    }
    const skipTruncate = input.skipTruncate === true;
    log.info('Agent running scenario', {
      toolCallId: id,
      scenarioId,
      skipTruncate,
    });
    ctx
      .sendTunnelCommand(
        'run-scenario',
        { scenarioId, ...(skipTruncate ? { skipTruncate } : {}) },
        300_000,
      )
      .then((result) => ctx.sendToolResult(id, JSON.stringify(result)));
    return true;
  },
};
