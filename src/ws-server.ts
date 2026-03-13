import http from 'node:http';
import net from 'node:net';
import { URL } from 'node:url';
import httpProxy from 'http-proxy';
import { WebSocketServer, WebSocket } from 'ws';
import type { WsRequest, WsResponse, WsEvent, ServerStatus, AppConfig } from './types.js';
import * as filesystem from './handlers/filesystem.js';
import { buildTree } from './handlers/filesystem.js';
import { search } from './handlers/search.js';
import { shell } from './handlers/shell.js';

type ActionHandler = (params: Record<string, unknown>) => Promise<unknown>;

let sandboxToken: string = '';
let proxyTarget: number | null = null;
let proxy: httpProxy | null = null;
let appConfig: AppConfig | null = null;

/** Store the app config so it can be sent in the initial frame. */
export function setAppConfig(config: AppConfig): void {
  appConfig = config;
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
  shell: (p) =>
    shell(p as { command: string; cwd?: string; timeout?: number }),
};

let httpServer: http.Server;
let wss: WebSocketServer;
let status: ServerStatus = 'bootstrapping';

export function getStatus(): ServerStatus {
  return status;
}

export function setStatus(s: ServerStatus): void {
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

function verifyToken(url: string | undefined): boolean {
  if (!sandboxToken) return true;
  const parsed = new URL(url || '/', 'http://localhost');
  return parsed.searchParams.get('token') === sandboxToken;
}

/** Check if this request is for the C&C control channel. */
function isCncPath(url: string | undefined): boolean {
  if (!url) return false;
  const pathname = new URL(url, 'http://localhost').pathname;
  return pathname === '/ws' || pathname === '/health';
}

export function startServer(port: number, token?: string): Promise<void> {
  sandboxToken = token || '';

  return new Promise((resolve) => {
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

    wss.on('connection', async (ws) => {
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
      if (isCncPath(req.url)) {
        // C&C WebSocket — auth required
        if (!verifyToken(req.url)) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
          wss.emit('connection', ws, req);
        });
      } else {
        // HMR / dev server WebSocket — proxy to tunnel
        if (!proxy) {
          socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
          socket.destroy();
          return;
        }
        proxy.ws(req, socket, head, {}, (err) => {
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
  if (!wss) return;
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
