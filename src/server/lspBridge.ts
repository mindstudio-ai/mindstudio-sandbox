import { WebSocket } from 'ws';
import { ctx } from './context.js';
import { createLogger } from '../logger.js';

const log = createLogger('lsp/ws');

export function createLspConnectionHandler(): (ws: WebSocket) => void {
  return (ws) => {
    log.info('WebSocket client connected');

    if (!ctx.lspClient?.isRunning) {
      log.error('Language server not running, closing connection');
      ws.close(1013, 'Language server not running');
      return;
    }

    ws.on('message', async (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.id !== undefined && msg.method) {
          try {
            const result = await ctx.lspClient!.request(msg.method, msg.params);
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
            }
          } catch (err) {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(
                JSON.stringify({
                  jsonrpc: '2.0',
                  id: msg.id,
                  error: {
                    code: -32603,
                    message:
                      err instanceof Error ? err.message : 'Unknown error',
                  },
                }),
              );
            }
          }
        } else {
          ctx.lspClient!.notify(msg.method, msg.params);
        }
      } catch {
        log.warn('Failed to parse WebSocket message');
      }
    });

    const unsubs: Array<() => void> = [];
    const forwardNotification = (method: string) => {
      const unsub = ctx.lspClient!.onNotification(method, (params) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ jsonrpc: '2.0', method, params }));
        }
      });
      unsubs.push(unsub);
    };

    forwardNotification('textDocument/publishDiagnostics');
    forwardNotification('window/logMessage');
    forwardNotification('window/showMessage');

    ws.on('close', () => {
      log.debug('WebSocket client disconnected');
      for (const unsub of unsubs) {
        unsub();
      }
    });
  };
}
