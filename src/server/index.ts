/**
 * WebSocket server — HTTP/WS lifecycle, upgrade routing, broadcast.
 *
 * Three WebSocket servers on a single HTTP port:
 *   /ws   — C&C (command & control) for the frontend
 *   /lsp  — TypeScript language server bridge for Monaco
 *   *     — HMR relay with buffering during agent turns
 */

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { URL } from 'node:url';
import httpProxy from 'http-proxy';
import { WebSocketServer, WebSocket } from 'ws';
import type { WsRequest, WsResponse, WsEvent, ServerStatus } from '../types.js';
import { ctx, buildInitFrame, buildFallbackInitFrame } from './context.js';
import { handlers } from './handlers/index.js';
import { HmrRelay, HmrRelayManager } from './server/HmrRelay.js';
import { createLogger } from '../logger.js';

const log = createLogger('ws-server');
const lspLog = createLogger('lsp-ws');

let sandboxToken: string = '';
let workspaceDir: string = '';
let proxyTarget: number | null = null;
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
    // Handled per-request below
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
  workspaceDir = wsDir || '';

  return new Promise((resolve) => {
    log.info(`Creating HTTP server on port ${port}`);
    log.debug(
      `Auth: ${sandboxToken ? 'token required' : 'disabled (no SANDBOX_TOKEN)'}`,
    );

    httpServer = http.createServer((req, res) => {
      if (req.url === '/health' || req.url?.startsWith('/health')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: ctx.status, proxyTarget }));
        return;
      }

      if (req.url?.startsWith('/logs/')) {
        const corsHeaders = {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET',
        };

        // Handle CORS preflight
        if (req.method === 'OPTIONS') {
          res.writeHead(204, corsHeaders);
          res.end();
          return;
        }

        const name = decodeURIComponent(req.url.slice('/logs/'.length));

        // Resolve log file path: process logs from registry, or
        // special files written directly by the tunnel.
        const STANDALONE_LOGS: Record<string, string> = {
          requests: '.logs/requests.ndjson',
          browser: '.logs/browser.ndjson',
        };
        let logPath = ctx.registry?.getLogPath(name) ?? STANDALONE_LOGS[name];
        if (!logPath) {
          res.writeHead(404, { 'Content-Type': 'text/plain', ...corsHeaders });
          res.end('Log not found');
          return;
        }

        const fullPath = path.join(workspaceDir, logPath);
        const contentType = logPath.endsWith('.ndjson')
          ? 'application/x-ndjson'
          : 'text/plain';

        fs.stat(fullPath)
          .then(async (stat) => {
            const rangeHeader = req.headers.range;
            if (rangeHeader) {
              // Parse "bytes=<start>-" range request
              const match = rangeHeader.match(/bytes=(\d+)-/);
              const start = match ? parseInt(match[1], 10) : 0;
              if (start >= stat.size) {
                // Nothing new — return empty 206
                res.writeHead(206, {
                  'Content-Type': contentType,
                  'Content-Range': `bytes ${stat.size}-${stat.size}/${stat.size}`,
                  'Content-Length': '0',
                  'Accept-Ranges': 'bytes',
                  'Cache-Control': 'no-cache',
                  ...corsHeaders,
                });
                res.end('');
                return;
              }
              const content = await fs.readFile(fullPath, 'utf-8');
              const slice = content.slice(start);
              res.writeHead(206, {
                'Content-Type': contentType,
                'Content-Range': `bytes ${start}-${stat.size - 1}/${stat.size}`,
                'Content-Length': String(Buffer.byteLength(slice)),
                'Accept-Ranges': 'bytes',
                'Cache-Control': 'no-cache',
                ...corsHeaders,
              });
              res.end(slice);
            } else {
              const content = await fs.readFile(fullPath, 'utf-8');
              res.writeHead(200, {
                'Content-Type': contentType,
                'Content-Length': String(Buffer.byteLength(content)),
                'Accept-Ranges': 'bytes',
                'Cache-Control': 'no-cache',
                ...corsHeaders,
              });
              res.end(content);
            }
          })
          .catch(() => {
            res.writeHead(200, {
              'Content-Type': contentType,
              'Content-Length': '0',
              'Accept-Ranges': 'bytes',
              ...corsHeaders,
            });
            res.end('');
          });
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

    // HMR WebSocket — relay with buffering during agent turns
    hmrWss = new WebSocketServer({ noServer: true, perMessageDeflate: false });

    // --- LSP bridge ---
    lspWss.on('connection', (ws) => {
      lspLog.info('WebSocket client connected');

      if (!ctx.lspClient?.isRunning) {
        lspLog.error('Language server not running, closing connection');
        ws.close(1013, 'Language server not running');
        return;
      }

      ws.on('message', async (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.id !== undefined && msg.method) {
            try {
              const result = await ctx.lspClient!.request(
                msg.method,
                msg.params,
              );
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
          lspLog.warn('Failed to parse WebSocket message');
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
        lspLog.debug('WebSocket client disconnected');
        for (const unsub of unsubs) {
          unsub();
        }
      });
    });

    // --- C&C connection ---
    wss.on('connection', async (ws) => {
      log.info(`C&C client connected (total: ${wss.clients.size})`);

      ws.on('close', (code, reason) => {
        log.debug(
          `C&C client disconnected (code=${code}, reason=${reason.toString() || 'none'}, remaining: ${wss.clients.size})`,
        );
      });

      // Send initial frame
      try {
        const frame = await buildInitFrame(proxy !== null);
        ws.send(JSON.stringify(frame));
      } catch {
        ws.send(JSON.stringify(buildFallbackInitFrame(proxy !== null)));
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
    });

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
  const msg: WsEvent = { event, ...data };
  const payload = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
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
