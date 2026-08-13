/**
 * C&C socket liveness.
 *
 * A half-open socket — TCP never torn down, peer gone — is indistinguishable
 * from an idle one, so something has to probe. That probe belongs on this side:
 * RFC 6455 ping/pong are control frames, which a browser answers from its own
 * network stack without running any JavaScript. A backgrounded tab whose timers
 * are throttled to once a minute still pongs on time, so liveness never depends
 * on client scheduling. The editor used to run an application-level
 * `{action:'ping'}` heartbeat instead, and that dependence is exactly what broke
 * it: a 60s deadline enforced by a throttled 60s timer tore down healthy
 * connections every couple of minutes.
 *
 * Same shape as every socket in youai-api (`src/ws/WebSocketState.ts`,
 * `LocalEditorState.ts`, `DbConnectionState.ts` — all identical): one interval
 * per connection, a count of outstanding pings, terminate once that count
 * reaches UNANSWERED_PINGS_BEFORE_GONE, and reset it on every pong. Cadence is
 * the tunnel dev proxy's 30s (`mindstudio-local-model-tunnel/src/dev/proxy/
 * proxy.ts`) rather than youai-api's 10s, because this socket's client is a
 * browser and a needless reconnect costs it a ~3MB init frame.
 */

import type { IncomingMessage } from 'node:http';
import type { WebSocket, WebSocketServer } from 'ws';
import { createLogger } from '../logger.js';

const log = createLogger('ws-server');

const PING_INTERVAL_MS = 30_000;

// Outstanding pings before a socket is treated as gone — so a peer has to miss
// two in a row, and termination lands ~90s after it stops answering.
//
// Not one. This process does synchronous multi-second work on the event loop (a
// ~3MB init frame is a JSON.stringify; getAgentHistory's own timeout comment
// budgets 30s because "the JSON parse + transformHistory pipeline can compete
// with broadcast/handler work on the event loop"). When a poll-phase callback
// blocks, an overdue timer runs in the *timers* phase before the poll phase
// delivers a pong that arrived mid-block — so a one-strike check would terminate
// healthy clients precisely when the server is busiest. Counting means that
// costs a strike instead of the connection.
const UNANSWERED_PINGS_BEFORE_GONE = 2;

/**
 * Ping C&C clients, reaping any that stop answering. Returns a stop function
 * that detaches from future connections; each connection's own interval is
 * cleared when its socket closes.
 */
export function startCncHeartbeat(wss: WebSocketServer): () => void {
  const onConnection = (ws: WebSocket, req: IncomingMessage) => {
    let unansweredPings = 0;

    const interval = setInterval(() => {
      if (unansweredPings >= UNANSWERED_PINGS_BEFORE_GONE) {
        clearInterval(interval);
        log.warn('C&C client stopped answering pings — terminating');
        ws.terminate();
        return;
      }
      unansweredPings += 1;
      try {
        ws.ping();
      } catch {
        clearInterval(interval);
        ws.terminate();
      }
    }, PING_INTERVAL_MS);
    // Liveness is never a reason to hold the process open.
    interval.unref();

    ws.on('pong', () => {
      unansweredPings = 0;
    });
    ws.on('close', () => clearInterval(interval));

    // Kernel-side backstop, outside the event loop entirely, so it survives the
    // pressure that can delay the interval above. Slow to fire on Linux defaults
    // (~11 min past the idle window, and the probe count isn't settable from
    // Node) — a floor under the application ping, not a replacement for it.
    req.socket.setKeepAlive(true, PING_INTERVAL_MS);
  };

  wss.on('connection', onConnection);

  return () => {
    wss.off('connection', onConnection);
  };
}
