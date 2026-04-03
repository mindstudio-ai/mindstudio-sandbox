import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import type httpProxy from 'http-proxy';
import { ctx } from './context.js';
import { createLogger } from '../logger.js';
import { getVersions } from './versionCache.js';
import { getAgentActivity } from '../processes/agent/activity.js';
import { getProjectStatus } from '../projectStatus/ProjectStatusManager.js';

const log = createLogger('http');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

const STANDALONE_LOGS: Record<string, string> = {
  requests: '.logs/requests.ndjson',
  browser: '.logs/browser.ndjson',
};

interface HttpHandlerOpts {
  workspaceDir: string;
  getProxyTarget: () => number | null;
  getProxy: () => httpProxy | null;
}

export function createHttpHandler(opts: HttpHandlerOpts): http.RequestListener {
  const { workspaceDir, getProxyTarget, getProxy } = opts;

  return (req, res) => {
    // CORS preflight — allow everything
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }

    if (req.url === '/health' || req.url?.startsWith('/health')) {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        ...CORS_HEADERS,
      });
      res.end(
        JSON.stringify({ status: ctx.status, proxyTarget: getProxyTarget() }),
      );
      return;
    }

    if (req.url === '/status' || req.url?.startsWith('/status?')) {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
        ...CORS_HEADERS,
      });
      res.end(JSON.stringify(buildStatusResponse()));
      return;
    }

    if (req.url === '/agent-stats' || req.url?.startsWith('/agent-stats?')) {
      const statsPath = path.join(workspaceDir, '.remy-stats.json');
      fs.readFile(statsPath, 'utf-8')
        .then((content) => {
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-cache',
            ...CORS_HEADERS,
          });
          res.end(content);
        })
        .catch(() => {
          res.writeHead(404, {
            'Content-Type': 'application/json',
            ...CORS_HEADERS,
          });
          res.end(JSON.stringify({ error: 'Stats not available yet' }));
        });
      return;
    }

    if (req.url?.startsWith('/logs/')) {
      serveLogs(req, res, workspaceDir);
      return;
    }

    const proxy = getProxy();
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
  };
}

function redactCommand(command: string): string {
  return command.replace(/(--api-key)\s+\S+/g, '$1 [REDACTED]');
}

function buildStatusResponse() {
  const processes = (ctx.registry?.getAllInfo() ?? []).map((p) => ({
    name: p.name,
    type: p.type,
    command: redactCommand(p.command),
    state: p.state,
    startedAt: p.startedAt,
    endedAt: p.endedAt,
    duration: p.duration,
    exitCode: p.exitCode,
    signal: p.signal,
    restartCount: p.restartCount,
    pid: p.pid,
  }));

  const appConfig = ctx.appConfig;
  const app = appConfig
    ? {
        appId: appConfig.appId,
        name: appConfig.name,
        methodCount: appConfig.methods.length,
        tableCount: appConfig.tables.length,
        interfaceCount: appConfig.interfaces.length,
        scenarioCount: appConfig.scenarios?.length ?? 0,
      }
    : null;

  return {
    timestamp: Date.now(),
    serverStatus: ctx.status,
    uptime: process.uptime() * 1000,
    versions: getVersions(),
    app,
    tunnel: ctx.tunnelSession,
    processes,
    resources: ctx.resourceMonitor?.collectNow() ?? null,
    agent: getAgentActivity(),
    projectStatus: getProjectStatus(),
    snapshot: ctx.snapshotManager?.getSnapshotStatus() ?? null,
  };
}

function serveLogs(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  workspaceDir: string,
): void {
  const name = decodeURIComponent(req.url!.slice('/logs/'.length));
  const logPath = ctx.registry?.getLogPath(name) ?? STANDALONE_LOGS[name];
  if (!logPath) {
    res.writeHead(404, { 'Content-Type': 'text/plain', ...CORS_HEADERS });
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
        const match = rangeHeader.match(/bytes=(\d+)-/);
        const start = match ? parseInt(match[1], 10) : 0;
        if (start >= stat.size) {
          res.writeHead(206, {
            'Content-Type': contentType,
            'Content-Range': `bytes ${stat.size}-${stat.size}/${stat.size}`,
            'Content-Length': '0',
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'no-cache',
            ...CORS_HEADERS,
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
          ...CORS_HEADERS,
        });
        res.end(slice);
      } else {
        const content = await fs.readFile(fullPath, 'utf-8');
        res.writeHead(200, {
          'Content-Type': contentType,
          'Content-Length': String(Buffer.byteLength(content)),
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-cache',
          ...CORS_HEADERS,
        });
        res.end(content);
      }
    })
    .catch(() => {
      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': '0',
        'Accept-Ranges': 'bytes',
        ...CORS_HEADERS,
      });
      res.end('');
    });
}
