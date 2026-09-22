/**
 * HMR WebSocket relay with message buffering.
 *
 * Sits between the browser's HMR client and the dev server. When the
 * agent is busy editing files, upstream→client messages are buffered
 * so the preview doesn't flash through broken intermediate states.
 * When the turn ends, all buffered messages are flushed at once.
 *
 * Framework agnostic — works with Vite, webpack, or any dev server.
 */

import WebSocket from 'ws';
import type { IncomingHttpHeaders } from 'node:http';
import { createLogger } from '../logger.ts';

const log = createLogger('hmr-relay');

// A WebSocket 'close' event can carry reserved codes — 1005 ("no status
// received") or 1006 ("abnormal closure") — that were never sent on the wire.
// Passing those to `ws.close(code)` throws "First argument must be a valid
// error code number". Only 1000 and 3000–4999 are valid to send (RFC 6455), so
// forward those and fall back to a clean 1000 for anything else. Without this,
// relaying a peer's close code straight through crashed the close handler on
// every socket drop (leaking the paired socket because `destroy()` never ran).
function safeCloseCode(code?: number): number {
  return code === 1000 ||
    (typeof code === 'number' && code >= 3000 && code <= 4999)
    ? code
    : 1000;
}

interface BufferedMessage {
  data: WebSocket.Data;
  isBinary: boolean;
}

export class HmrRelay {
  private client: WebSocket;
  private upstream: WebSocket;
  private agentBuffer: BufferedMessage[] = [];
  private pendingClientMessages: BufferedMessage[] = [];
  private buffering = false;
  private upstreamReady = false;
  private destroyed = false;
  private onDestroy: (() => void) | null = null;

  constructor(
    clientWs: WebSocket,
    upstreamUrl: string,
    clientHeaders?: IncomingHttpHeaders,
  ) {
    this.client = clientWs;

    // Forward relevant headers from the original client request
    const headers: Record<string, string> = {};
    if (clientHeaders?.origin) {
      headers['Origin'] = clientHeaders.origin;
    }
    if (clientHeaders?.cookie) {
      headers['Cookie'] = clientHeaders.cookie;
    }
    if (clientHeaders?.host) {
      headers['Host'] = clientHeaders.host;
    }

    // Forward subprotocol if the client requested one (e.g. "vite-hmr")
    const protocols =
      clientHeaders?.['sec-websocket-protocol']
        ?.split(',')
        .map((p) => p.trim()) ?? [];

    log.debug(
      `Connecting upstream: ${upstreamUrl} (protocols: ${protocols.join(', ') || 'none'})`,
    );
    this.upstream = new WebSocket(upstreamUrl, protocols, {
      headers,
      perMessageDeflate: false,
    });

    // Wait for upstream to be ready before forwarding
    this.upstream.on('open', () => {
      log.debug('Upstream connected');
      this.upstreamReady = true;
      // Flush any client messages that arrived before upstream was ready
      for (const msg of this.pendingClientMessages) {
        this.upstream.send(msg.data, { binary: msg.isBinary });
      }
      this.pendingClientMessages.length = 0;
    });

    // Upstream → client (bufferable during agent turns)
    this.upstream.on('message', (data, isBinary) => {
      if (this.destroyed) {
        return;
      }
      if (this.buffering) {
        this.agentBuffer.push({ data, isBinary });
        return;
      }
      if (this.client.readyState === WebSocket.OPEN) {
        this.client.send(data, { binary: isBinary });
      }
    });

    // Client → upstream (always passthrough, queued until upstream ready)
    this.client.on('message', (data, isBinary) => {
      if (this.destroyed) {
        return;
      }
      if (!this.upstreamReady) {
        this.pendingClientMessages.push({ data, isBinary });
        return;
      }
      if (this.upstream.readyState === WebSocket.OPEN) {
        this.upstream.send(data, { binary: isBinary });
      }
    });

    // Lifecycle: if either side closes, close the other. Sanitize the code
    // (peer 'close' events surface reserved 1005/1006 that ws.close() rejects)
    // and guard the call so destroy() always runs even if close() still throws.
    this.upstream.on('close', (code, reason) => {
      log.debug(`Upstream closed (code=${code})`);
      if (this.client.readyState === WebSocket.OPEN) {
        try {
          this.client.close(safeCloseCode(code), reason);
        } catch (err) {
          log.debug(
            `Failed to relay close to client: ${(err as Error).message}`,
          );
        }
      }
      this.destroy();
    });

    this.client.on('close', (code, reason) => {
      log.debug(`Client closed (code=${code})`);
      if (this.upstream.readyState === WebSocket.OPEN) {
        try {
          this.upstream.close(safeCloseCode(code), reason);
        } catch (err) {
          log.debug(
            `Failed to relay close to upstream: ${(err as Error).message}`,
          );
        }
      }
      this.destroy();
    });

    this.upstream.on('error', (err) => {
      log.error(`Upstream error: ${err.message}`);
      this.destroy();
    });
    this.client.on('error', () => this.destroy());
  }

  setBuffering(enabled: boolean): void {
    if (this.destroyed) {
      return;
    }
    if (this.buffering && !enabled) {
      this.flush();
    }
    this.buffering = enabled;
  }

  /** Register a callback for when this relay is destroyed. */
  onClose(fn: () => void): void {
    this.onDestroy = fn;
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.agentBuffer.length = 0;
    this.pendingClientMessages.length = 0;

    if (this.client.readyState <= WebSocket.OPEN) {
      this.client.close();
    }
    if (this.upstream.readyState <= WebSocket.OPEN) {
      this.upstream.close();
    }

    this.onDestroy?.();
  }

  private flush(): void {
    if (this.agentBuffer.length === 0) {
      return;
    }
    log.debug(`Flushing ${this.agentBuffer.length} buffered HMR messages`);
    for (const msg of this.agentBuffer) {
      if (this.client.readyState === WebSocket.OPEN) {
        this.client.send(msg.data, { binary: msg.isBinary });
      }
    }
    this.agentBuffer.length = 0;
  }
}

export class HmrRelayManager {
  private relays = new Set<HmrRelay>();
  private buffering = false;

  add(relay: HmrRelay): void {
    this.relays.add(relay);
    relay.onClose(() => this.relays.delete(relay));
    if (this.buffering) {
      relay.setBuffering(true);
    }
  }

  /** Start buffering HMR messages (agent began editing files). */
  startBuffering(): void {
    if (this.buffering) {
      return;
    }
    this.buffering = true;
    for (const relay of this.relays) {
      relay.setBuffering(true);
    }
  }

  /** Flush buffered messages and resume normal relay. */
  flush(): void {
    if (!this.buffering) {
      return;
    }
    this.buffering = false;
    for (const relay of this.relays) {
      relay.setBuffering(false);
    }
  }

  destroyAll(): void {
    for (const relay of this.relays) {
      relay.destroy();
    }
    this.relays.clear();
  }
}
