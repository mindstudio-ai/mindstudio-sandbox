import http from 'node:http';
import { URL } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import type { WsRequest, WsResponse, WsEvent, ServerStatus } from './types.js';
import * as filesystem from './handlers/filesystem.js';
import { search } from './handlers/search.js';
import { shell } from './handlers/shell.js';

type ActionHandler = (params: Record<string, unknown>) => Promise<unknown>;

let sandboxToken: string = '';

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

export function startServer(port: number, token?: string): Promise<void> {
  sandboxToken = token || '';

  return new Promise((resolve) => {
    httpServer = http.createServer((req, res) => {
      if (req.url === '/health' || req.url?.startsWith('/health')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status }));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    wss = new WebSocketServer({
      server: httpServer,
      verifyClient: ({ req }, done) => {
        if (!sandboxToken) {
          // No token configured — allow all connections
          done(true);
          return;
        }
        const url = new URL(req.url || '/', `http://${req.headers.host}`);
        const token = url.searchParams.get('token');
        if (token === sandboxToken) {
          done(true);
        } else {
          done(false, 401, 'Unauthorized');
        }
      },
    });

    wss.on('connection', (ws) => {
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
