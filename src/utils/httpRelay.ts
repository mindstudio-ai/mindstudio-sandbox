/**
 * Dependency-free relay primitives for the two hops that forward to a loopback
 * port without wanting to understand what passes through.
 *
 * The C&C uses both to reach the tunnel's `DevProxy` on behalf of a human (the
 * editor iframe, a phone); `DevProxy` uses `relayUpgrade` to reach the dev
 * server's HMR socket. Neither hop adds anything here: no inspection, no
 * buffering, no header rewriting beyond addressing the upstream. What the C&C
 * hop DOES add — HMR buffering during agent turns, the visitor placeholders,
 * token gating — lives in `server/`, beside the decision of when to relay at all.
 *
 * This replaced `http-proxy`. Two of its behaviours are kept on purpose: one
 * connection per request (`agent: false` — loopback makes that free, and it
 * keeps the `Connection` semantics the tunnel has always seen), and headers
 * otherwise copied verbatim. One is dropped on purpose: it held response headers
 * until the first body byte, so an idle `text/event-stream` did not settle its
 * `fetch()` until the platform's 15 s keepalive, and the C&C carried a
 * `setImmediate(flushHeaders)` workaround for exactly that. `relayRequest`
 * flushes headers the moment the upstream answers, for every response — the
 * event-stream case stopped being a case.
 *
 * `Host` is rewritten to the loopback upstream on both primitives. `DevProxy`
 * already did that on every path of its own and never reads the incoming one;
 * the dev server behind it checks `Host` (Vite's DNS-rebinding guard), which is
 * why it matters at all.
 */

import http from 'node:http';
import type net from 'node:net';

/**
 * Forward one request to `port` and stream the response back. `onUnreachable`
 * runs only if the upstream failed before anything was written — the caller
 * still owns the response then and answers with something of its own.
 */
export function relayRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  port: number,
  onUnreachable: () => void,
): void {
  const upstreamReq = http.request(
    {
      hostname: '127.0.0.1',
      port,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: `localhost:${port}` },
      agent: false,
    },
    (upstreamRes) => {
      res.writeHead(
        upstreamRes.statusCode ?? 502,
        upstreamRes.statusMessage,
        upstreamRes.headers,
      );
      // Now, not with the first body byte — see the header.
      res.flushHeaders();
      upstreamRes.pipe(res);
    },
  );

  upstreamReq.on('error', () => {
    if (res.headersSent) {
      // Mid-body there is no status left to send; tearing the socket down is
      // what tells the client the body is incomplete rather than short.
      res.destroy();
    } else {
      onUnreachable();
    }
  });

  // The client left before the upstream finished: stop reading from it.
  res.on('close', () => {
    if (!res.writableFinished) {
      upstreamReq.destroy();
    }
  });

  req.pipe(upstreamReq);
}

/**
 * Splice a WebSocket upgrade through to `port`: forward the handshake, relay
 * the upstream's answer, then pipe bytes both ways until either side closes.
 */
export function relayUpgrade(
  req: http.IncomingMessage,
  clientSocket: net.Socket,
  head: Buffer,
  port: number,
): void {
  const upstreamReq = http.request({
    hostname: '127.0.0.1',
    port,
    path: req.url,
    method: req.method,
    headers: { ...req.headers, host: `localhost:${port}` },
  });

  upstreamReq.on('upgrade', (upstreamRes, upstreamSocket, upgradeHead) => {
    clientSocket.write(statusAndHeaders(upstreamRes));
    if (upgradeHead.length > 0) {
      clientSocket.write(upgradeHead);
    }
    if (head.length > 0) {
      upstreamSocket.write(head);
    }

    upstreamSocket.pipe(clientSocket);
    clientSocket.pipe(upstreamSocket);

    clientSocket.on('close', () => upstreamSocket.destroy());
    upstreamSocket.on('close', () => clientSocket.destroy());
    clientSocket.on('error', () => upstreamSocket.destroy());
    upstreamSocket.on('error', () => clientSocket.destroy());
  });

  // The upstream declined to upgrade (a 4xx, say). Relay its answer rather than
  // leave the client holding a socket that never speaks.
  upstreamReq.on('response', (upstreamRes) => {
    clientSocket.write(statusAndHeaders(upstreamRes));
    upstreamRes.pipe(clientSocket);
  });

  upstreamReq.on('error', () => {
    clientSocket.destroy();
  });

  upstreamReq.end();
}

/** An upstream response's status line and raw headers, as wire bytes. */
function statusAndHeaders(res: http.IncomingMessage): string {
  let out = `HTTP/${res.httpVersion} ${res.statusCode} ${res.statusMessage}\r\n`;
  for (let i = 0; i < res.rawHeaders.length; i += 2) {
    out += `${res.rawHeaders[i]}: ${res.rawHeaders[i + 1]}\r\n`;
  }
  return out + '\r\n';
}
