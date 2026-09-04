import { WebSocket } from 'ws';
import { ctx } from './context.js';
import { createLogger } from '../logger.js';

const log = createLogger('lsp/ws');

/**
 * Lifecycle and server-global messages a bridge client may send but which must
 * never reach the shared language server. There is exactly one server for
 * every consumer (Monaco tabs, remy's sidecar), and `LspClient` already ran its
 * handshake, so these are answered here:
 *
 *   initialize   → the cached result of the real handshake. Forwarding this is
 *                  what leaked a tsserver per editor page load (RPT-1213):
 *                  typescript-language-server spawns a fresh tsserver on every
 *                  `initialize` and never kills the previous one.
 *   initialized  → swallowed (already sent by LspClient).
 *   shutdown     → `null`, without shutting anything down.
 *   exit         → swallowed; closes only this client's socket.
 *   $/setTrace, workspace/didChangeConfiguration
 *                → swallowed. The sandbox owns the shared server's config.
 *
 * Everything else (textDocument/*, completionItem/resolve, …) is forwarded.
 */
const LOCAL_REQUESTS = new Set(['initialize', 'shutdown']);
const SWALLOWED_NOTIFICATIONS = new Set([
  'initialized',
  'exit',
  '$/setTrace',
  'workspace/didChangeConfiguration',
]);

function send(ws: WebSocket, payload: Record<string, unknown>): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ jsonrpc: '2.0', ...payload }));
  }
}

export function createLspConnectionHandler(): (ws: WebSocket) => void {
  return (ws) => {
    log.info('WebSocket client connected');

    // Kept as-is: during a language-server relaunch gap this 1013 is what
    // drives the editor's reconnect backoff.
    if (!ctx.lspClient?.isRunning) {
      log.error('Language server not running, closing connection');
      ws.close(1013, 'Language server not running');
      return;
    }

    ws.on('message', async (data) => {
      let msg: { id?: number | string; method?: string; params?: unknown };
      try {
        msg = JSON.parse(data.toString());
      } catch {
        log.warn('Failed to parse WebSocket message');
        return;
      }

      const isRequest = msg.id !== undefined && !!msg.method;

      if (isRequest && LOCAL_REQUESTS.has(msg.method!)) {
        if (msg.method === 'initialize') {
          const result = ctx.lspClient?.getInitializeResult();
          if (result) {
            send(ws, { id: msg.id, result });
          } else {
            send(ws, {
              id: msg.id,
              error: { code: -32603, message: 'Language server not running' },
            });
            ws.close(1013, 'Language server not running');
          }
        } else {
          // shutdown
          send(ws, { id: msg.id, result: null });
        }
        return;
      }

      if (!isRequest && msg.method && SWALLOWED_NOTIFICATIONS.has(msg.method)) {
        if (msg.method === 'exit') {
          ws.close(1000, 'Client exit');
        }
        return;
      }

      if (isRequest) {
        try {
          const result = await ctx.lspClient!.request(msg.method!, msg.params);
          send(ws, { id: msg.id, result });
        } catch (err) {
          send(ws, {
            id: msg.id,
            error: {
              code: -32603,
              message: err instanceof Error ? err.message : 'Unknown error',
            },
          });
        }
      } else if (msg.method) {
        ctx.lspClient!.notify(msg.method, msg.params);
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
