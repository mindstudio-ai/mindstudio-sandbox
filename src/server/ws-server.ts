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
} from '../types.js';
import {
  buildTree,
  listDir,
  readFile,
  writeFile,
  deleteFile,
  renameFile,
} from './handlers/filesystem.js';
import { search } from './handlers/search.js';
import { shell } from './handlers/shell.js';
import type { ProcessManager } from '../processes/process-manager.js';
import type { ProcessRegistry } from '../processes/process-registry.js';
import type { BroadcastBatcher } from './broadcast-batcher.js';
import type { LspClient } from '../lsp/client.js';
import { createLogger } from '../logger.js';

const log = createLogger('ws-server');
const lspLog = createLogger('lsp-ws');

type ActionHandler = (params: Record<string, unknown>) => Promise<unknown>;

let sandboxToken: string = '';
let proxyTarget: number | null = null;
let proxy: httpProxy | null = null;
let appConfig: AppConfig | null = null;
let processManager: ProcessManager | null = null;
let batcher: BroadcastBatcher | null = null;
let registryRef: ProcessRegistry | null = null;

// Pending get_history callbacks — resolved when the agent emits a `history` event
let historyResolvers: Array<(messages: unknown[]) => void> = [];

/** Called from index.ts when a `history` event arrives from the agent. */
export function resolveHistoryRequest(messages: unknown[]): void {
  const resolvers = historyResolvers;
  historyResolvers = [];
  for (const resolve of resolvers) {
    resolve(messages);
  }
}

/** Request chat history from the agent process. Returns [] if agent isn't running or times out. */
function getAgentHistory(): Promise<unknown[]> {
  if (!processManager || processManager.getState('agent') !== 'running') {
    return Promise.resolve([]);
  }
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      historyResolvers = historyResolvers.filter((r) => r !== resolve);
      resolve([]);
    }, 2000);
    historyResolvers.push((messages) => {
      clearTimeout(timeout);
      resolve(messages);
    });
    processManager!.writeStdin(
      'agent',
      JSON.stringify({ action: 'get_history' }),
    );
  });
}

/** Store the app config so it can be sent in the initial frame. */
export function setAppConfig(config: AppConfig): void {
  appConfig = config;
}

/** Store the process manager so agent actions can write to stdin / restart. */
export function setProcessManager(pm: ProcessManager): void {
  processManager = pm;
  // Grab registry reference from the process manager
  registryRef = null; // will be set via the pm's internal registry
}

/** Store the batcher for batched broadcasts. */
export function setBatcher(b: BroadcastBatcher): void {
  batcher = b;
}

/** Set the registry ref so init frame can access process info. */
export function setRegistry(reg: ProcessRegistry): void {
  registryRef = reg;
}

const actions: Record<string, ActionHandler> = {
  listDir: (p) => listDir(p as { path: string }),
  readFile: (p) => readFile(p as { path: string }),
  writeFile: (p) => writeFile(p as { path: string; content: string }),
  deleteFile: (p) => deleteFile(p as { path: string }),
  renameFile: (p) => renameFile(p as { oldPath: string; newPath: string }),
  search: (p) => search(p as Parameters<typeof search>[0]),
  shell: (p) => shell(p as { command: string; cwd?: string; timeout?: number }),
  agentMessage: async (p) => {
    const { text } = p as { text: string };
    if (!processManager) {
      throw new Error('Process manager not initialized');
    }
    if (processManager.getState('agent') !== 'running') {
      throw new Error('Agent not running');
    }
    log.info(`Sending message to agent: ${text.slice(0, 100)}...`);
    processManager.writeStdin(
      'agent',
      JSON.stringify({ action: 'message', text }),
    );
    return {};
  },
  agentCancel: async () => {
    if (!processManager) {
      throw new Error('Process manager not initialized');
    }
    if (processManager.getState('agent') !== 'running') {
      throw new Error('Agent not running');
    }
    log.info('Cancelling agent turn');
    processManager.writeStdin('agent', JSON.stringify({ action: 'cancel' }));
    return {};
  },
  agentClear: async () => {
    if (!processManager) {
      throw new Error('Process manager not initialized');
    }
    if (processManager.getState('agent') !== 'running') {
      throw new Error('Agent not running');
    }
    log.info('Clearing agent session');
    processManager.writeStdin('agent', JSON.stringify({ action: 'clear' }));
    return {};
  },
  getProcesses: async () => {
    return { processes: processManager?.getProcesses() ?? [] };
  },
  getProcessLog: async (p) => {
    const { name } = p as { name: string };
    if (!name) {
      throw new Error('Missing "name" parameter');
    }
    return { log: processManager?.getProcessLog(name) ?? [] };
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
  log.info(`Status: ${status} → ${s}`);
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
  log.info(`Preview proxy target set to localhost:${port}`);
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
    log.info(`Creating HTTP server on port ${port}`);
    log.debug(
      `Auth: ${sandboxToken ? 'token required' : 'disabled (no SANDBOX_TOKEN)'}`,
    );

    httpServer = http.createServer((req, res) => {
      if (req.url === '/health' || req.url?.startsWith('/health')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status, proxyTarget }));
        return;
      }

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
      lspLog.info('WebSocket client connected');

      if (!lspClient?.isRunning) {
        lspLog.error('Language server not running, closing connection');
        ws.close(1013, 'Language server not running');
        return;
      }

      ws.on('message', async (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.id !== undefined && msg.method) {
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
            lspClient!.notify(msg.method, msg.params);
          }
        } catch {
          lspLog.warn('Failed to parse WebSocket message');
        }
      });

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
        lspLog.debug('WebSocket client disconnected');
        for (const unsub of unsubs) {
          unsub();
        }
      });
    });

    wss.on('connection', async (ws) => {
      log.info(`C&C client connected (total: ${wss.clients.size})`);

      ws.on('close', (code, reason) => {
        log.debug(
          `C&C client disconnected (code=${code}, reason=${reason.toString() || 'none'}, remaining: ${wss.clients.size})`,
        );
      });

      // Send initial frame with everything the client needs to bootstrap
      try {
        const [tree, chatHistory] = await Promise.all([
          buildTree(),
          getAgentHistory(),
        ]);
        ws.send(
          JSON.stringify({
            event: 'init',
            status,
            previewAvailable: proxy !== null,
            app: appConfig,
            fileTree: tree,
            chatHistory,
            processes: registryRef?.getAllInfo() ?? [],
            outputLog: registryRef?.getMergedLog() ?? [],
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
            chatHistory: [],
            processes: [],
            outputLog: [],
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
      log.debug(`WebSocket upgrade: ${pathname}`);

      if (pathname === '/lsp') {
        log.debug('Upgrading LSP WebSocket');
        lspWss.handleUpgrade(req, socket, head, (ws) => {
          lspWss.emit('connection', ws, req);
        });
      } else if (isCncPath(req.url)) {
        if (!verifyToken(req.url)) {
          log.warn(`Rejected: invalid token on ${pathname}`);
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }
        log.debug(`Upgrading C&C WebSocket on ${pathname}`);
        wss.handleUpgrade(req, socket, head, (ws) => {
          wss.emit('connection', ws, req);
        });
      } else {
        if (!proxy) {
          log.warn(`HMR proxy not ready, returning 503 for ${pathname}`);
          socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
          socket.destroy();
          return;
        }
        log.debug(
          `Proxying HMR WebSocket: ${pathname} → localhost:${proxyTarget}`,
        );
        proxy.ws(req, socket, head, {}, (err) => {
          log.error(`HMR proxy error: ${err?.message}`);
          socket.destroy();
        });
      }
    });

    httpServer.listen(port, () => {
      log.info(`Listening on port ${port}`);
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
