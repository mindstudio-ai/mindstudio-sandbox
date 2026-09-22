import { createLogger } from '../../logger.ts';
import type { ExternalToolHandler } from '../types.ts';
import type { BrowserStep } from '../../devTunnel/protocol.ts';

const log = createLogger('tool:browserCommand');

export const browserCommandTool: ExternalToolHandler = {
  handle(id, input, ctx) {
    // Model-authored input, so check it is at least an array. The tunnel
    // validates each step's `command` itself — which is why `BrowserStep` keeps
    // an index signature and this side needs no case per browser verb.
    const steps: BrowserStep[] = Array.isArray(input.steps)
      ? (input.steps as BrowserStep[])
      : [];
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
