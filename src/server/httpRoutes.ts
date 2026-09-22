import http from 'node:http';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream';
import { createGzip } from 'node:zlib';
import { ctx } from './context.ts';
import { relayRequest } from '../utils/httpRelay.ts';
import { getVersions } from './versionCache.ts';
import { getAgentActivity } from '../processes/agent/activity.ts';
import { getSandboxBrowserState } from '../processes/tunnel/browserState.ts';
import { getProjectStatus } from '../projectStatus/ProjectStatusManager.ts';
import { sendPreviewPlaceholder } from './previewPlaceholder.ts';

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

//////////////////////////////////////////////////////////////////////////////
// Serving workspace files
//////////////////////////////////////////////////////////////////////////////

/**
 * Stream a workspace file back, gzipped when the client accepts it.
 *
 * Everything this serves is append-only text that grows for the life of the app rather than the
 * life of the box: `.remy-session.json` was 22.8MB on the box that motivated this, the usage ledger
 * 2.4MB, and the process logs 1.7MB each. Reading those into a string first (which is what every
 * handler here used to do) meant ~30MB of heap materialized before a byte went out whenever the
 * debug collector asked for all of them at once, in a guest whose base memory is 2GiB — and it
 * pushed time-to-first-byte out past the collector's deadline, so the reports that mattered most
 * arrived with their largest artifacts missing.
 *
 * Streaming fixes the heap and the latency; gzip fixes the bytes, and NDJSON compresses about 10:1.
 * The browser decodes `Content-Encoding` transparently, so callers see identical content either way
 * and nothing downstream had to change. Not applied to Range requests — the editor's live log tail
 * reads incrementally by offset, and a compressed body would have to be re-fetched whole.
 */
function sendWorkspaceFile(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  fullPath: string,
  contentType: string,
  onMissing: () => void,
): void {
  fs.stat(fullPath)
    .then((stat) => {
      const gzip = (req.headers['accept-encoding'] ?? '').includes('gzip');
      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'no-cache',
        // Chunked when compressed: the encoded length isn't known until the stream ends, and
        // guessing it wrong is worse than omitting it.
        ...(gzip
          ? { 'Content-Encoding': 'gzip' }
          : { 'Content-Length': String(stat.size) }),
        'Accept-Ranges': 'bytes',
        ...CORS_HEADERS,
      });
      const source = createReadStream(fullPath);
      const onDone = (err: NodeJS.ErrnoException | null) => {
        // Headers are already out, so there is no status left to send. Tearing the socket down is
        // what tells the client the body is incomplete rather than handing it a silent truncation.
        if (err) {
          res.destroy();
        }
      };
      if (gzip) {
        // Level 1: the point is fewer bytes on the wire, not the smallest possible archive, and the
        // client decompresses immediately. On NDJSON this still lands around 7:1 for a fraction of
        // the CPU that level 6 would spend compressing a 20MB session dump inside the guest.
        pipeline(source, createGzip({ level: 1 }), res, onDone);
      } else {
        pipeline(source, res, onDone);
      }
    })
    .catch(onMissing);
}

interface HttpHandlerOpts {
  workspaceDir: string;
  /** The tunnel proxy's port once a session has started; null before. */
  getProxyTarget: () => number | null;
  /** Whether a request carries the box's own SANDBOX_TOKEN — see `/flush`. */
  verifyToken: (url: string | undefined) => boolean;
  /**
   * The same, but a box with no token configured refuses rather than allowing. For the two routes
   * that CHANGE something, on a port the public preview host can reach.
   */
  verifyTokenStrict: (url: string | undefined) => boolean;
}

export function createHttpHandler(opts: HttpHandlerOpts): http.RequestListener {
  const { workspaceDir, getProxyTarget, verifyToken, verifyTokenStrict } = opts;

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
      sendWorkspaceFile(
        req,
        res,
        path.join(workspaceDir, '.remy-stats.json'),
        'application/json',
        () => {
          res.writeHead(404, {
            'Content-Type': 'application/json',
            ...CORS_HEADERS,
          });
          res.end(JSON.stringify({ error: 'Stats not available yet' }));
        },
      );
      return;
    }

    if (
      req.url === '/agent-session' ||
      req.url?.startsWith('/agent-session?')
    ) {
      sendWorkspaceFile(
        req,
        res,
        path.join(workspaceDir, '.remy-session.json'),
        'application/json',
        () => {
          res.writeHead(404, {
            'Content-Type': 'application/json',
            ...CORS_HEADERS,
          });
          res.end(JSON.stringify({ error: 'Session not available' }));
        },
      );
      return;
    }

    if (req.url === '/agent-usage' || req.url?.startsWith('/agent-usage?')) {
      // Append-only NDJSON ledger of every billable LLM/CLI call across the
      // session. Survives /clear, restarts, compaction. Served verbatim;
      // consumers run jq queries over it.
      sendWorkspaceFile(
        req,
        res,
        path.join(workspaceDir, '.logs', 'usage.ndjson'),
        'application/x-ndjson',
        () => {
          res.writeHead(404, {
            'Content-Type': 'application/json',
            ...CORS_HEADERS,
          });
          res.end(JSON.stringify({ error: 'Usage ledger not available yet' }));
        },
      );
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
    // Token-gated STRICTLY, unlike the read-only routes above: it mutates, and this port is also
    // what the PUBLIC preview host reaches. `verifyTokenStrict` rather than `verifyToken` because
    // the latter allows everything when no token is configured, which on a box booted without
    // SANDBOX_TOKEN would let anything running in a user's own preview drive the platform's
    // snapshot machinery. The sandbox-proxy also lists this path as control now, so preview traffic
    // is refused a hop earlier — this is the second layer, not the only one.
    if (
      req.method === 'POST' &&
      new URL(req.url ?? '/', 'http://localhost').pathname === '/flush'
    ) {
      if (!verifyTokenStrict(req.url)) {
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

    // Everything else is the preview: relayed to the tunnel's proxy, which
    // fronts the dev server. This hop adds nothing to the bytes — the two
    // placeholders are what a visitor gets when there is nothing to relay to.
    const port = getProxyTarget();
    if (!port) {
      sendPreviewPlaceholder(req, res, 'starting');
      return;
    }
    relayRequest(req, res, port, () => {
      sendPreviewPlaceholder(req, res, 'unavailable');
    });
  };
}

/** Read a JSON request body. */
function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8').trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('invalid_json'));
      }
    });
    req.on('error', reject);
  });
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
        scenarioCount: appConfig.scenarios.length,
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

  const rangeHeader = req.headers.range;
  if (!rangeHeader) {
    // A log that no process has written yet is not an error — the editor asks for all of them and
    // shows an empty pane for the quiet ones — so a missing file answers 200 with nothing in it.
    sendWorkspaceFile(req, res, fullPath, contentType, () => {
      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': '0',
        'Accept-Ranges': 'bytes',
        ...CORS_HEADERS,
      });
      res.end('');
    });
    return;
  }

  fs.stat(fullPath)
    .then((stat) => {
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
      res.writeHead(206, {
        'Content-Type': contentType,
        'Content-Range': `bytes ${start}-${stat.size - 1}/${stat.size}`,
        'Content-Length': String(stat.size - start),
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-cache',
        ...CORS_HEADERS,
      });
      // Read from the offset rather than slicing the whole file. This is the live-tail path: the
      // editor re-asks every time a log grows, so reading 1.7MB to return the newest 200 bytes was
      // paid on every poll, for every open log pane, for the life of the box.
      pipeline(
        createReadStream(fullPath, { start, end: stat.size - 1 }),
        res,
        (err) => {
          if (err) {
            res.destroy();
          }
        },
      );
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
