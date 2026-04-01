/**
 * WebSocket server — HTTP/WS lifecycle, upgrade routing, broadcast.
 *
 * WebSocket servers on a single HTTP port:
 *   /ws                      — C&C (command & control) for the frontend
 *   /lsp                     — TypeScript language server bridge for Monaco
 *   /__mindstudio_dev__/ws   — tunnel automation (direct proxy, no buffering)
 *   *                        — HMR relay with buffering during agent turns
 */

import http from 'node:http';
import net from 'node:net';
import { URL } from 'node:url';
import httpProxy from 'http-proxy';
import { WebSocketServer, WebSocket } from 'ws';
import type { WsEvent, ServerStatus } from '../types.js';
import { ctx } from './context.js';
import { HmrRelay, HmrRelayManager } from './HmrRelay.js';
import { createHttpHandler } from './httpRoutes.js';
import { createLspConnectionHandler } from './lspBridge.js';
import { createCncConnectionHandler } from './cncConnection.js';
import { createLogger } from '../logger.js';

const log = createLogger('ws-server');

let sandboxToken: string = '';
let proxyTarget: number | null = null;
/** Clients that haven't received their init frame yet — skip in broadcast. */
const pendingInit = new Set<WebSocket>();
let proxy: httpProxy | null = null;

let httpServer: http.Server;
let wss: WebSocketServer;
let lspWss: WebSocketServer;
let hmrWss: WebSocketServer;
const hmrRelayManager = new HmrRelayManager();

export function getStatus(): ServerStatus {
  return ctx.status;
}

export function setStatus(s: ServerStatus): void {
  log.info(`Status: ${ctx.status} → ${s}`);
  ctx.status = s;
}

/** Set the tunnel proxy port for reverse proxying preview/HMR traffic. */
export function setProxyTarget(port: number): void {
  proxyTarget = port;
  hmrRelayManager.destroyAll();
  if (proxy) {
    proxy.close();
  }
  proxy = httpProxy.createProxyServer({
    target: `http://127.0.0.1:${port}`,
    ws: true,
  });
  proxy.on('error', () => {
    // Handled per-request in httpRoutes
  });
  log.info(`Preview proxy target set to localhost:${port}`);
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

export function startServer(
  port: number,
  token?: string,
  wsDir?: string,
): Promise<void> {
  sandboxToken = token || '';
  const workspaceDir = wsDir || '';

  return new Promise((resolve) => {
    log.info(`Creating HTTP server on port ${port}`);
    log.debug(
      `Auth: ${sandboxToken ? 'token required' : 'disabled (no SANDBOX_TOKEN)'}`,
    );

    // HTTP server
    httpServer = http.createServer(
      createHttpHandler({
        workspaceDir,
        getProxyTarget: () => proxyTarget,
        getProxy: () => proxy,
      }),
    );

    // WebSocket servers
    wss = new WebSocketServer({ noServer: true });
    lspWss = new WebSocketServer({ noServer: true });
    hmrWss = new WebSocketServer({ noServer: true, perMessageDeflate: false });

    lspWss.on('connection', createLspConnectionHandler());
    wss.on(
      'connection',
      createCncConnectionHandler({
        pendingInit,
        getProxyActive: () => proxy !== null,
        getClientCount: () => wss.clients.size,
      }),
    );

    // --- WebSocket upgrade routing ---
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
      } else if (pathname === '/__mindstudio_dev__/ws') {
        // Tunnel automation WebSocket — direct proxy, no HMR relay/buffering
        if (!proxy) {
          log.warn('Tunnel proxy not ready, returning 503 for automation WS');
          socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
          socket.destroy();
          return;
        }
        log.debug('Proxying tunnel automation WebSocket');
        proxy.ws(req, socket, head);
      } else {
        if (!proxyTarget) {
          log.warn(`HMR proxy not ready, returning 503 for ${pathname}`);
          socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
          socket.destroy();
          return;
        }
        log.debug(
          `Relaying HMR WebSocket: ${pathname} → localhost:${proxyTarget}`,
        );
        hmrWss.handleUpgrade(req, socket, head, (clientWs) => {
          const url = new URL(req.url || '/', 'http://localhost');
          const upstreamUrl = `ws://127.0.0.1:${proxyTarget}${url.pathname}${url.search}`;
          const relay = new HmrRelay(clientWs, upstreamUrl, req.headers);
          hmrRelayManager.add(relay);
        });
      }
    });

    httpServer.listen(port, () => {
      log.info(`Listening on port ${port}`);
      resolve();
    });
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function broadcast(event: string, data: Record<string, any>): void {
  if (!wss) {
    return;
  }
  let payload: string;
  try {
    const msg: WsEvent = { event, ...data };
    payload = JSON.stringify(msg);
  } catch (err) {
    log.error(
      `Failed to serialize broadcast event "${event}": ${err instanceof Error ? err.message : err}`,
    );
    return;
  }
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN && !pendingInit.has(client)) {
      try {
        client.send(payload);
      } catch (err) {
        log.warn(
          `Failed to send "${event}" to client: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  }

  // HMR buffering: start on first file op, flush on turn end
  if (event === 'agentActivityChanged') {
    const fileOps = data.fileOps as unknown[];
    if (Array.isArray(fileOps) && fileOps.length > 0) {
      hmrRelayManager.startBuffering();
    }
    if (!(data.busy as boolean)) {
      hmrRelayManager.flush();
    }
  }
}

/** Flush HMR buffer (called when agent signals edits are finished). */
export function flushHmr(): void {
  hmrRelayManager.flush();
}

export function stopServer(): Promise<void> {
  return new Promise((resolve) => {
    hmrRelayManager.destroyAll();
    if (proxy) {
      proxy.close();
    }
    if (hmrWss) {
      hmrWss.close();
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
