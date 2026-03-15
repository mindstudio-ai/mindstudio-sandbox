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
import { createTunnelActions } from '../processes/tunnel/index.js';
import {
  createAgentActions,
  getAgentHistory,
  getAgentActivity,
} from '../processes/agent/index.js';
import type { BroadcastBatcher } from './broadcast-batcher.js';
import type { EditorStateManager } from './editor-state.js';
import type { ResourceMonitor } from '../processes/resource-monitor.js';
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
let registry: ProcessRegistry | null = null;
let editorState: EditorStateManager | null = null;
let resourceMonitorRef: ResourceMonitor | null = null;

/** Store the app config so it can be sent in the initial frame. */
export function setAppConfig(config: AppConfig): void {
  appConfig = config;
}

/** Store the process manager and wire up process-specific actions. */
export function setProcessManager(pm: ProcessManager): void {
  processManager = pm;
  // Merge process-specific actions now that pm is available
  Object.assign(actions, createTunnelActions(pm));
  Object.assign(actions, createAgentActions(pm));
}

/** Store the batcher for batched broadcasts. */
export function setBatcher(b: BroadcastBatcher): void {
  batcher = b;
}

/** Set the registry so init frame can access process info. */
export function setRegistry(reg: ProcessRegistry): void {
  registry = reg;
}

/** Set the editor state manager for tab actions + init frame. */
export function setEditorState(editor: EditorStateManager): void {
  editorState = editor;
}

/** Set the resource monitor for on-demand snapshots. */
export function setResourceMonitor(monitor: ResourceMonitor): void {
  resourceMonitorRef = monitor;
}

const actions: Record<string, ActionHandler> = {
  // --- Filesystem ---
  listDir: (p) => listDir(p as { path: string }),
  readFile: (p) => readFile(p as { path: string }),
  writeFile: (p) => writeFile(p as { path: string; content: string }),
  deleteFile: async (p) => {
    const params = p as { path: string };
    const result = await deleteFile(params);
    editorState?.onFileDeleted(params.path);
    return result;
  },
  renameFile: async (p) => {
    const params = p as { oldPath: string; newPath: string };
    const result = await renameFile(params);
    editorState?.onFileRenamed(params.oldPath, params.newPath);
    return result;
  },
  search: (p) => search(p as Parameters<typeof search>[0]),
  shell: (p) => shell(p as { command: string; cwd?: string; timeout?: number }),

  // --- Processes ---
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

  // --- Editor ---
  openFile: async (p) => {
    const { path, preview } = p as { path: string; preview?: boolean };
    if (!path) {
      throw new Error('Missing "path" parameter');
    }
    editorState?.openFile(path, preview ?? false);
    return {};
  },
  closeFile: async (p) => {
    const { path } = p as { path: string };
    if (!path) {
      throw new Error('Missing "path" parameter');
    }
    editorState?.closeFile(path);
    return {};
  },
  setActiveTab: async (p) => {
    const { path } = p as { path: string };
    if (!path) {
      throw new Error('Missing "path" parameter');
    }
    editorState?.setActiveTab(path);
    return {};
  },
  reorderTabs: async (p) => {
    const { paths } = p as { paths: string[] };
    if (!Array.isArray(paths)) {
      throw new Error('Missing "paths" parameter (array of file paths)');
    }
    editorState?.reorderTabs(paths);
    return {};
  },
  expandDir: async (p) => {
    const { path } = p as { path: string };
    if (!path) {
      throw new Error('Missing "path" parameter');
    }
    editorState?.expandDir(path);
    return {};
  },
  collapseDir: async (p) => {
    const { path } = p as { path: string };
    if (!path) {
      throw new Error('Missing "path" parameter');
    }
    editorState?.collapseDir(path);
    return {};
  },
  toggleDir: async (p) => {
    const { path } = p as { path: string };
    if (!path) {
      throw new Error('Missing "path" parameter');
    }
    editorState?.toggleDir(path);
    return {};
  },

  // --- Resources ---
  getResources: async () => {
    return resourceMonitorRef?.collectNow() ?? {};
  },

  // Agent and tunnel actions are merged in via setProcessManager()
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
          processManager
            ? getAgentHistory(processManager)
            : Promise.resolve([]),
        ]);
        ws.send(
          JSON.stringify({
            event: 'init',
            status,
            previewAvailable: proxy !== null,
            app: appConfig,
            fileTree: tree,
            chatHistory,
            processes: registry?.getAllInfo() ?? [],
            outputLog: registry?.getMergedLog() ?? [],
            agentActivity: getAgentActivity(),
            editorState: editorState?.getState() ?? {
              tabs: [],
              activeTab: null,
            },
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
            agentActivity: getAgentActivity(),
            editorState: { tabs: [], activeTab: null, expandedDirs: [] },
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
