import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import type httpProxy from 'http-proxy';
import { ctx } from './context.js';
import { getVersions } from './versionCache.js';
import { getAgentActivity } from '../processes/agent/activity.js';
import { getSandboxBrowserState } from '../processes/tunnel/index.js';
import { getProjectStatus } from '../projectStatus/ProjectStatusManager.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

// How long `/flush` may take before it answers anyway. Above the snapshot's own
// tar+upload for a large home, and below the platform's call timeout, so the
// caller gets a verdict rather than an abort.
const FLUSH_TIMEOUT_MS = 100_000;

const STANDALONE_LOGS: Record<string, string> = {
  requests: '.logs/requests.ndjson',
  browser: '.logs/browser.ndjson',
};

interface HttpHandlerOpts {
  workspaceDir: string;
  getProxyTarget: () => number | null;
  getProxy: () => httpProxy | null;
  /** Whether a request carries the box's own SANDBOX_TOKEN — see `/flush`. */
  verifyToken: (url: string | undefined) => boolean;
}

export function createHttpHandler(opts: HttpHandlerOpts): http.RequestListener {
  const { workspaceDir, getProxyTarget, getProxy, verifyToken } = opts;

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

    if (
      req.url === '/agent-session' ||
      req.url?.startsWith('/agent-session?')
    ) {
      const sessionPath = path.join(workspaceDir, '.remy-session.json');
      fs.readFile(sessionPath, 'utf-8')
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
          res.end(JSON.stringify({ error: 'Session not available' }));
        });
      return;
    }

    if (req.url === '/agent-usage' || req.url?.startsWith('/agent-usage?')) {
      // Append-only NDJSON ledger of every billable LLM/CLI call across the
      // session. Survives /clear, restarts, compaction. Served verbatim;
      // consumers run jq queries over it.
      const usagePath = path.join(workspaceDir, '.logs', 'usage.ndjson');
      fs.readFile(usagePath, 'utf-8')
        .then((content) => {
          res.writeHead(200, {
            'Content-Type': 'application/x-ndjson',
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
          res.end(JSON.stringify({ error: 'Usage ledger not available yet' }));
        });
      return;
    }

    if (req.url?.startsWith('/logs/')) {
      serveLogs(req, res, workspaceDir);
      return;
    }

    // POST /flush — snapshot home now and report the outcome.
    //
    // The platform calls this in-VPC immediately before it deletes the pod, and waits for the
    // answer: a stop we initiate must not depend on SIGTERM arriving, on the kubelet's grace
    // surviving whatever issued the delete, or on anyone inferring success from a health probe.
    // SIGTERM stays the backstop for stops we DON'T initiate (node drain, eviction, deadline).
    //
    // Token-gated, unlike the read-only routes above: this is the one mutating platform
    // operation on this port, and this port is also what the PUBLIC preview host reaches (the
    // sandbox-proxy deliberately doesn't list `/flush` as a control path, so a request for it on
    // a preview host arrives here as ordinary traffic). Without the check, anything running in a
    // user's own preview could drive the platform's snapshot machinery.
    if (
      req.method === 'POST' &&
      new URL(req.url ?? '/', 'http://localhost').pathname === '/flush'
    ) {
      if (!verifyToken(req.url)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      const finalize = ctx.finalizeWorkspace;
      if (!finalize) {
        // Pre-bootstrap: nothing is wired yet, so there is also nothing to lose.
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, outcome: 'not_ready' }));
        return;
      }
      Promise.race([
        finalize(),
        new Promise<'timeout'>((r) =>
          setTimeout(() => r('timeout'), FLUSH_TIMEOUT_MS),
        ),
      ])
        .then((outcome) => {
          // `not_ready` is a success for the caller's purpose: the box holds nothing of the
          // user's, so stopping it loses nothing.
          const ok =
            outcome === 'committed' ||
            outcome === 'unchanged' ||
            outcome === 'not_ready';
          res.writeHead(ok ? 200 : 500, {
            'Content-Type': 'application/json',
          });
          res.end(
            JSON.stringify({
              ok,
              outcome,
              error: ctx.snapshotManager?.getSnapshotStatus().lastError ?? null,
            }),
          );
        })
        .catch((err) => {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              ok: false,
              outcome: 'failed',
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        });
      return;
    }

    const proxy = getProxy();
    if (!proxy) {
      res.writeHead(503, { 'Content-Type': 'text/html' });
      res.end('<html><body><p>Preview starting...</p></body></html>');
      return;
    }

    proxy.web(req, res, {}, () => {
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
    sandboxBrowser: getSandboxBrowserState(),
    processes,
    resources: ctx.resourceMonitor?.collectNow() ?? null,
    agent: getAgentActivity(),
    projectStatus: getProjectStatus(),
    snapshot: ctx.snapshotManager?.getSnapshotStatus() ?? null,
    installFailures: ctx.installFailures ?? null,
  };
}

function serveLogs(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  workspaceDir: string,
): void {
  // Pathname only: the sandbox proxy carries its credential as a query string.
  const pathname = new URL(req.url!, 'http://localhost').pathname;
  const name = decodeURIComponent(pathname.slice('/logs/'.length));
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
        const buf = await fs.readFile(fullPath);
        const slice = buf.subarray(start);
        res.writeHead(206, {
          'Content-Type': contentType,
          'Content-Range': `bytes ${start}-${stat.size - 1}/${stat.size}`,
          'Content-Length': String(slice.length),
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
