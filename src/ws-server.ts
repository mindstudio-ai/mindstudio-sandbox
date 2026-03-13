import http from 'node:http';
import net from 'node:net';
import { URL } from 'node:url';
import httpProxy from 'http-proxy';
import { WebSocketServer, WebSocket } from 'ws';
import type {
  WsRequest,
  WsResponse,
  WsEvent,
  ServerStatus,
  AppConfig,
} from './types.js';
import * as filesystem from './handlers/filesystem.js';
import { buildTree } from './handlers/filesystem.js';
import { search } from './handlers/search.js';
import { shell } from './handlers/shell.js';
import type { ProcessManager } from './process-manager.js';
import type { LspClient } from './lsp-client.js';
import {
  getChatHistory,
  getOutputLog,
  trackUserMessage,
  trackAgentEvent,
} from './state.js';

// Re-export so index.ts can keep importing from ws-server
export { trackAgentEvent, trackUserMessage };

type ActionHandler = (params: Record<string, unknown>) => Promise<unknown>;

let sandboxToken: string = '';
let proxyTarget: number | null = null;
let proxy: httpProxy | null = null;
let appConfig: AppConfig | null = null;
let pm: ProcessManager | null = null;

/** Store the app config so it can be sent in the initial frame. */
export function setAppConfig(config: AppConfig): void {
  appConfig = config;
}

/** Store the process manager so agent actions can write to stdin / restart. */
export function setProcessManager(processManager: ProcessManager): void {
  pm = processManager;
}

const actions: Record<string, ActionHandler> = {
  listDir: (p) => filesystem.listDir(p as { path: string }),
  readFile: (p) => filesystem.readFile(p as { path: string }),
  writeFile: (p) =>
    filesystem.writeFile(p as { path: string; content: string }),
  deleteFile: (p) => filesystem.deleteFile(p as { path: string }),
  renameFile: (p) =>
    filesystem.renameFile(p as { oldPath: string; newPath: string }),
  search: (p) => search(p as Parameters<typeof search>[0]),
  shell: (p) => shell(p as { command: string; cwd?: string; timeout?: number }),
  agentMessage: async (p) => {
    const { text } = p as { text: string };
    if (!pm) {
      throw new Error('Process manager not initialized');
    }
    if (pm.getState('agent') !== 'running') {
      throw new Error('Agent not running');
    }
    console.log(
      `[ws-server] Sending message to agent: ${text.slice(0, 100)}...`,
    );
    trackUserMessage(text);
    pm.writeStdin('agent', JSON.stringify({ action: 'message', text }));
    return {};
  },
  agentCancel: async () => {
    if (!pm) {
      throw new Error('Process manager not initialized');
    }
    console.log('[ws-server] Cancelling agent — restarting process');
    broadcast('agentError', { error: 'Cancelled by user' });
    await pm.restart('agent');
    return {};
  },
};

let httpServer: http.Server;
let wss: WebSocketServer;
let lspWss: WebSocketServer;
let lspClient: LspClient | null = null;
let status: ServerStatus = 'bootstrapping';

export function getStatus(): ServerStatus {
  return status;
}

export function setStatus(s: ServerStatus): void {
  console.log(`[ws-server] Status: ${status} → ${s}`);
  status = s;
}

/** Set the tunnel proxy port for reverse proxying preview/HMR traffic. */
export function setProxyTarget(port: number): void {
  proxyTarget = port;
  if (proxy) {
    proxy.close();
  }
  proxy = httpProxy.createProxyServer({
    target: `http://127.0.0.1:${port}`,
    ws: true,
  });
  proxy.on('error', () => {
    // Handled per-request below
  });
  console.log(`[ws-server] Preview proxy target set to localhost:${port}`);
}

/** Set the shared LSP client for WebSocket bridge and sidecar. */
export function setLspClient(client: LspClient): void {
  lspClient = client;
}

function verifyToken(url: string | undefined): boolean {
  if (!sandboxToken) {
    return true;
  }
  const parsed = new URL(url || '/', 'http://localhost');
  return parsed.searchParams.get('token') === sandboxToken;
}

/** Check if this request is for the C&C control channel. */
/** Paths handled by the C&C server (not proxied to HMR/preview). */
function isCncPath(url: string | undefined): boolean {
  if (!url) {
    return false;
  }
  const pathname = new URL(url, 'http://localhost').pathname;
  return pathname === '/ws' || pathname === '/health' || pathname === '/lsp';
}

export function startServer(port: number, token?: string): Promise<void> {
  sandboxToken = token || '';

  return new Promise((resolve) => {
    console.log(`[ws-server] Creating HTTP server on port ${port}`);
    console.log(
      `[ws-server] Auth: ${sandboxToken ? 'token required' : 'disabled (no SANDBOX_TOKEN)'}`,
    );

    httpServer = http.createServer((req, res) => {
      // Health endpoint — always served by C&C
      if (req.url === '/health' || req.url?.startsWith('/health')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status, proxyTarget }));
        return;
      }

      // Everything else → reverse proxy to tunnel proxy
      if (!proxy) {
        res.writeHead(503, { 'Content-Type': 'text/html' });
        res.end('<html><body><p>Preview starting...</p></body></html>');
        return;
      }

      proxy.web(req, res, {}, (err) => {
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'text/html' });
          res.end('<html><body><p>Preview unavailable</p></body></html>');
        }
      });
    });

    // C&C WebSocket — only on /ws path
    wss = new WebSocketServer({ noServer: true });

    // LSP WebSocket — bridges Monaco to the shared LspClient
    lspWss = new WebSocketServer({ noServer: true });
    lspWss.on('connection', (ws) => {
      console.log('[lsp] WebSocket client connected');

      if (!lspClient?.isRunning) {
        console.error('[lsp] Language server not running, closing connection');
        ws.close(1013, 'Language server not running');
        return;
      }

      // WebSocket → language server (route through LspClient)
      ws.on('message', async (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.id !== undefined && msg.method) {
            // Request — route response back to this WS
            try {
              const result = await lspClient!.request(msg.method, msg.params);
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
            // Notification — fire and forget
            lspClient!.notify(msg.method, msg.params);
          }
        } catch {
          console.error('[lsp] Failed to parse WebSocket message');
        }
      });

      // Language server notifications → WebSocket
      const unsubs: Array<() => void> = [];
      const forwardNotification = (method: string) => {
        const unsub = lspClient!.onNotification(method, (params) => {
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
        console.log('[lsp] WebSocket client disconnected');
        for (const unsub of unsubs) {
          unsub();
        }
      });
    });

    wss.on('connection', async (ws) => {
      console.log(
        `[ws-server] C&C WebSocket client connected (total: ${wss.clients.size})`,
      );

      ws.on('close', (code, reason) => {
        console.log(
          `[ws-server] C&C WebSocket client disconnected (code=${code}, reason=${reason.toString() || 'none'}, remaining: ${wss.clients.size})`,
        );
      });

      // Send initial frame with everything the client needs to bootstrap
      try {
        const tree = await buildTree();
        ws.send(
          JSON.stringify({
            event: 'init',
            status,
            previewAvailable: proxy !== null,
            app: appConfig,
            fileTree: tree,
            chatHistory: getChatHistory(),
            outputLog: getOutputLog(),
          }),
        );
      } catch {
        ws.send(
          JSON.stringify({
            event: 'init',
            status,
            previewAvailable: proxy !== null,
            app: appConfig,
            fileTree: [],
          }),
        );
      }

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

        const handler = actions[request.action];
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
    });

    // Handle all WebSocket upgrades — route by path
    httpServer.on('upgrade', (req, socket: net.Socket, head) => {
      const pathname = new URL(req.url || '/', 'http://localhost').pathname;
      console.log(`[ws-server] WebSocket upgrade: ${pathname}`);

      if (pathname === '/lsp') {
        // LSP WebSocket — bridges to language server
        console.log('[ws-server] Upgrading LSP WebSocket');
        lspWss.handleUpgrade(req, socket, head, (ws) => {
          lspWss.emit('connection', ws, req);
        });
      } else if (isCncPath(req.url)) {
        // C&C WebSocket — auth required
        if (!verifyToken(req.url)) {
          console.log(`[ws-server] Rejected: invalid token on ${pathname}`);
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }
        console.log(`[ws-server] Upgrading C&C WebSocket on ${pathname}`);
        wss.handleUpgrade(req, socket, head, (ws) => {
          wss.emit('connection', ws, req);
        });
      } else {
        // HMR / dev server WebSocket — proxy to tunnel
        if (!proxy) {
          console.log(
            `[ws-server] HMR proxy not ready, returning 503 for ${pathname}`,
          );
          socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
          socket.destroy();
          return;
        }
        console.log(
          `[ws-server] Proxying HMR WebSocket: ${pathname} → localhost:${proxyTarget}`,
        );
        proxy.ws(req, socket, head, {}, (err) => {
          console.error(`[ws-server] HMR proxy error: ${err?.message}`);
          socket.destroy();
        });
      }
    });

    httpServer.listen(port, () => {
      console.log(`[ws-server] Listening on port ${port}`);
      resolve();
    });
  });
}

export function broadcast(event: string, data: Record<string, unknown>): void {
  if (!wss) {
    return;
  }
  const msg: WsEvent = { event, ...data };
  const payload = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

export function stopServer(): Promise<void> {
  return new Promise((resolve) => {
    if (proxy) {
      proxy.close();
    }
    if (lspWss) {
      for (const client of lspWss.clients) {
        client.close(1001, 'Server shutting down');
      }
      lspWss.close();
    }
    if (wss) {
      for (const client of wss.clients) {
        client.close(1001, 'Server shutting down');
      }
      wss.close();
    }
    if (httpServer) {
      httpServer.close(() => resolve());
    } else {
      resolve();
    }
  });
}
