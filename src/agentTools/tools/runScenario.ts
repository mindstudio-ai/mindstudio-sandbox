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
    log.info('Agent running scenario', { toolCallId: id, scenarioId });
    ctx
      .sendTunnelCommand('run-scenario', { scenarioId }, 30_000)
      .then((result) => ctx.sendToolResult(id, JSON.stringify(result)));
    return true;
  },
};
