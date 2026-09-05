import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import type httpProxy from 'http-proxy';
import { ctx } from './context.js';
import { getVersions } from './versionCache.js';
import { getAgentActivity } from '../processes/agent/activity.js';
import { quiesceAgent } from '../processes/agent/actions.js';
import { getSandboxBrowserState } from '../processes/tunnel/index.js';
import { getProjectStatus } from '../projectStatus/ProjectStatusManager.js';
import { recordActivity } from '../activity.js';

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

    // AFTER the health and preflight returns, and that ordering is the whole point: /health is
    // polled by the platform — every second while a session starts, and periodically by
    // SandboxManager.verify — so counting it would make an abandoned box look permanently busy and
    // make this signal useless for deciding idleness. What is left is real traffic: preview page
    // loads, proxied app requests, the standalone log endpoints.
    recordActivity('http');

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

    // Pre-destroy flush: quiesce the agent and push a final _draft snapshot.
    // Called by the platform right before it stops the sandbox (Vercel's
    // stop is an abrupt kill — SIGTERM never arrives). Must sit ABOVE the
    // proxy fallthrough or it would route to the dev server.
    if (req.url === '/flush' || req.url?.startsWith('/flush?')) {
      if (req.method !== 'POST') {
        res.writeHead(405, {
          'Content-Type': 'application/json',
          ...CORS_HEADERS,
        });
        res.end(JSON.stringify({ error: 'POST required' }));
        return;
      }
      // Single-flight: concurrent flush requests share one run.
      const run =
        flushInFlight ??
        (flushInFlight = runFlush().finally(() => {
          flushInFlight = null;
        }));
      run.then((result) => {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          ...CORS_HEADERS,
        });
        res.end(JSON.stringify(result));
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

//////////////////////////////////////////////////////////////////////////////
// Pre-destroy flush
//////////////////////////////////////////////////////////////////////////////

// Budgets sum to ~18s worst case (quiesce + settle + snapshot), comfortably
// inside the platform's 20s client timeout — the route always responds.
const FLUSH_QUIESCE_BUDGET_MS = 8_000;
// remy emits its cancel terminal BEFORE the (sync) session-file write — give
// the write a beat to land once the agent reports idle.
const FLUSH_SETTLE_MS = 750;
const FLUSH_SNAPSHOT_BUDGET_MS = 9_000;

interface FlushResult {
  flushed: boolean;
  quiesced: boolean;
  durationMs: number;
  reason?: string;
}

let flushInFlight: Promise<FlushResult> | null = null;

async function runFlush(): Promise<FlushResult> {
  const start = Date.now();
  // Only flush a fully-booted sandbox. 'bootstrapping': the restore may not
  // have run yet, so a snapshot could push scaffold/partial state over the
  // real draft. 'error': the restore was unresolvable — pushing would
  // overwrite good work.
  if (ctx.status !== 'ready' || !ctx.snapshotManager) {
    return {
      flushed: false,
      quiesced: false,
      durationMs: Date.now() - start,
      reason: `not_ready (${ctx.status})`,
    };
  }
  const quiesced = ctx.processManager
    ? await quiesceAgent(ctx.processManager, FLUSH_QUIESCE_BUDGET_MS)
    : true;
  if (quiesced) {
    await new Promise((r) => setTimeout(r, FLUSH_SETTLE_MS));
  }
  // Bounded: respond even if a slow git push overruns — the snapshot keeps
  // running in the background and may still land before the container dies.
  const flushed = await Promise.race([
    ctx.snapshotManager.flushNow().catch(() => false),
    new Promise<boolean>((r) =>
      setTimeout(() => r(false), FLUSH_SNAPSHOT_BUDGET_MS),
    ),
  ]);
  return { flushed, quiesced, durationMs: Date.now() - start };
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
