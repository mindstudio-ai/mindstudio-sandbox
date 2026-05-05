import { WebSocket } from 'ws';
import type { WsRequest, WsResponse } from '../types.js';
import { buildInitFrame, buildFallbackInitFrame } from './context.js';
import { handlers } from './wsHandlers/index.js';
import { createLogger } from '../logger.js';

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
