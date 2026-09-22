import { WebSocket } from 'ws';
import type { WsRequest, WsResponse } from '../types.ts';
import { buildInitFrame, buildFallbackInitFrame } from './context.ts';
import { handlers } from './wsHandlers/index.ts';
import {
  getActiveTurnId,
  getActiveTurnModel,
} from '../processes/agent/activity.ts';
import { createLogger } from '../logger.ts';

const log = createLogger('ws-server');

interface CncConnectionOpts {
  pendingInit: Set<WebSocket>;
  getProxyActive: () => boolean;
  getClientCount: () => number;
}

export function createCncConnectionHandler(
  opts: CncConnectionOpts,
): (ws: WebSocket) => void {
  const { pendingInit, getProxyActive, getClientCount } = opts;

  return async (ws) => {
    log.info(`C&C client connected (total: ${getClientCount()})`);
    pendingInit.add(ws);

    ws.on('close', (code, reason) => {
      pendingInit.delete(ws);
      log.debug(
        `C&C client disconnected (code=${code}, reason=${reason.toString() || 'none'}, remaining: ${getClientCount()})`,
      );
    });

    // Send initial frame — broadcasts are suppressed until this completes
    try {
      const frame = await buildInitFrame(getProxyActive());
      const payload = JSON.stringify(frame);
      const messages = Array.isArray(frame.chatHistory)
        ? frame.chatHistory.length
        : -1;
      log.info('Sending init frame', {
        bytes: payload.length,
        messages,
        chatHistoryTotalCount: frame.chatHistoryTotalCount,
      });
      ws.send(payload);
    } catch (err) {
      // Silent fallbacks here have masked real bugs (e.g. an empty
      // chatHistory because a downstream getAgentHistory crashed). Surface
      // anything that throws so future regressions are diagnosable.
      log.error(
        `Init frame build failed, sending fallback: ${err instanceof Error ? err.message : err}`,
      );
      if (err instanceof Error && err.stack) {
        log.error(err.stack);
      }
      ws.send(JSON.stringify(buildFallbackInitFrame(getProxyActive())));
    }
    pendingInit.delete(ws);

    // Rehydrate the in-flight turn's model attribution. `agentTurnStarted`
    // fires once, at turn start, so a client that connects mid-turn — a reload
    // during a long build — otherwise can't tell the turn is running on an
    // override model until it commits to history. Nothing in the init frame
    // carries it: `agentRunning` comes from remy's history payload, which has
    // no attribution for the running turn.
    //
    // Same event name and shape as the live broadcast, so the frontend has one
    // rehydration path. Sent only to this socket rather than broadcast, so
    // other open tabs don't re-run their turn-start handling.
    //
    // Gated on our own turn state (driven by the `completed` event) rather
    // than remy's `running` flag, so a finished turn can't leave a rail
    // hanging. Fails closed: no cached attribution means no event.
    const activeTurnId = getActiveTurnId();
    const activeTurnModel = getActiveTurnModel();
    if (activeTurnId && activeTurnModel) {
      ws.send(
        JSON.stringify({
          event: 'agentTurnStarted',
          requestId: activeTurnId,
          ...activeTurnModel,
        }),
      );
      log.debug('Re-emitted agentTurnStarted for in-flight turn', {
        requestId: activeTurnId,
      });
    }

    // Request dispatch
    ws.on('message', async (raw) => {
      let request: WsRequest;
      try {
        request = JSON.parse(raw.toString()) as WsRequest;
      } catch {
        ws.send(
          JSON.stringify({
            requestId: 'unknown',
            success: false,
            error: 'Invalid JSON',
          }),
        );
        return;
      }

      const handler = handlers[request.action];
      if (!handler) {
        const resp: WsResponse = {
          requestId: request.requestId,
          success: false,
          error: `Unknown action: ${request.action}`,
        };
        ws.send(JSON.stringify(resp));
        return;
      }

      try {
        const data = await handler(request.params || {});
        const resp: WsResponse = {
          requestId: request.requestId,
          success: true,
          data,
        };
        ws.send(JSON.stringify(resp));
      } catch (err) {
        const resp: WsResponse = {
          requestId: request.requestId,
          success: false,
          error: err instanceof Error ? err.message : 'Unknown error',
        };
        ws.send(JSON.stringify(resp));
      }
    });
  };
}
