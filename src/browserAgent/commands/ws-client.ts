/**
 * WebSocket client — persistent connection to the tunnel proxy.
 *
 * All mutable state lives on window.__ms.ws (via getState()) so it
 * survives HMR module replacement.
 *
 * Auto-reconnects with exponential backoff on disconnection.
 */

import {
  executeSteps,
  peekPendingNavigationId,
  resumePendingNavigation,
} from './executor';
import { setWsGetter } from '../transport';
import { getState } from '../state';
import type {
  BrowserStep,
  CommandResult,
  PageHello,
  PageResult,
  ProxyBroadcast,
  ProxyToPageMessage,
} from '../protocol';

const WS_PATH = '/__mindstudio_dev__/ws';
const RECONNECT_BASE = 1000;
const RECONNECT_MAX = 10_000;

export function initWebSocket(): void {
  const s = getState().ws;
  if (s.ws) {
    return;
  }

  // Register WS getter with transport so logs can be sent over WS
  setWsGetter(getSocket);

  window.addEventListener('beforeunload', () => {
    s.closing = true;
    if (s.ws) {
      s.ws.close();
    }
  });

  connect();
}

/**
 * Returns the current WebSocket if it's open, or null.
 * Used by the transport layer to send logs over WS.
 */
export function getSocket(): WebSocket | null {
  const { ws } = getState().ws;
  if (ws && ws.readyState === WebSocket.OPEN) {
    return ws;
  }
  return null;
}

function getWsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}${WS_PATH}`;
}

export function getMode(): 'iframe' | 'standalone' {
  return window.parent !== window ? 'iframe' : 'standalone';
}

/**
 * Detect sandbox-browser mode. The tunnel's launcher navigates Chrome to a
 * URL with `?ms_sandbox=1` — we latch that marker into sessionStorage on
 * first load so it survives `location.href = '/'` reloads (e.g. from the
 * proxy's reset-browser broadcast). Subsequent hellos still advertise the
 * sandbox identity without relying on the URL.
 */
export function isSandboxBrowser(): boolean {
  try {
    if (location.search.includes('ms_sandbox=1')) {
      sessionStorage.setItem('__ms_sandbox', '1');
      return true;
    }
    return sessionStorage.getItem('__ms_sandbox') === '1';
  } catch {
    return location.search.includes('ms_sandbox=1');
  }
}

function connect(): void {
  const s = getState().ws;
  if (s.closing) {
    return;
  }

  try {
    s.ws = new WebSocket(getWsUrl());
  } catch {
    scheduleReconnect();
    return;
  }

  s.ws.onopen = () => {
    // Send hello to identify this client
    try {
      const isMirrorSource = (() => {
        try {
          return sessionStorage.getItem('__ms_mirror') === '1';
        } catch {
          return false;
        }
      })();
      s.ws!.send(
        JSON.stringify({
          type: 'hello',
          mode: getMode(),
          url: location.href,
          viewport: { w: window.innerWidth, h: window.innerHeight },
          mirror: isMirrorSource,
          sandbox: isSandboxBrowser(),
          // Peek only: checkPendingNavigation consumes the stash after ack.
          resumingCommandId: peekPendingNavigationId(),
        } satisfies PageHello),
      );
    } catch {
      // Hello failed — close and reconnect
      s.ws?.close();
    }
  };

  s.ws.onmessage = (event) => {
    let msg: ProxyToPageMessage;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }

    switch (msg.type) {
      case 'ack':
        s.clientId = msg.clientId;
        // Reset backoff on successful connection
        s.reconnectDelay = RECONNECT_BASE;
        // Check for pending navigation — resume remaining steps from before page navigated
        checkPendingNavigation();
        break;

      case 'command':
        handleCommand(msg.id, msg.steps);
        break;

      case 'broadcast':
        handleBroadcast(msg.action, msg.payload);
        break;
    }
  };

  s.ws.onclose = () => {
    s.ws = null;
    s.clientId = null;
    if (!s.closing) {
      scheduleReconnect();
    }
  };

  s.ws.onerror = () => {
    // onclose will fire after this — reconnect handled there
  };
}

function scheduleReconnect(): void {
  const s = getState().ws;
  if (s.closing) {
    return;
  }
  setTimeout(() => connect(), s.reconnectDelay);
  s.reconnectDelay = Math.min(s.reconnectDelay * 2, RECONNECT_MAX);
}

async function handleCommand(id: string, steps: BrowserStep[]): Promise<void> {
  const s = getState().ws;
  if (s.busy) {
    // Already executing a command — reject this one immediately
    sendResult({
      id,
      steps: [],
      snapshot: '',
      logs: [],
      duration: 0,
      error: 'Browser agent is busy',
    });
    return;
  }

  s.busy = true;
  notifyParent('command-started', { id, steps: steps.map((s) => s.command) });
  try {
    const result = await executeSteps(id, steps);
    sendResult(result);
    notifyParent('command-completed', { id, success: true });
  } catch {
    sendResult({
      id,
      steps: [],
      snapshot: '',
      logs: [],
      duration: 0,
    });
    notifyParent('command-completed', { id, success: false });
  } finally {
    getState().ws.busy = false;
  }
}

function sendResult(result: CommandResult): void {
  try {
    const sock = getSocket();
    if (sock) {
      sock.send(
        JSON.stringify({ type: 'result', ...result } satisfies PageResult),
      );
    }
  } catch {
    // Socket may have closed between check and send — result is lost,
    // server will time out and reject the command.
  }
}

async function checkPendingNavigation(): Promise<void> {
  const result = await resumePendingNavigation();
  if (result) {
    sendResult(result);
  }
}

function notifyParent(command: string, data?: Record<string, unknown>): void {
  if (window.parent === window) {
    return;
  }
  window.parent.postMessage(
    { channel: 'mindstudio-browser-agent', command, ...data },
    '*',
  );
}

function handleBroadcast(
  action: ProxyBroadcast['action'],
  _payload?: ProxyBroadcast['payload'],
): void {
  switch (action) {
    case 'reload':
      // Clear auth cookie and navigate to root
      document.cookie = '__ms_auth=; Max-Age=0; Path=/; Secure; SameSite=None';
      location.href = '/';
      break;
  }
}
