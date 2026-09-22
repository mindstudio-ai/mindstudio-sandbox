/**
 * Transport layer — buffers log entries and flushes them to the proxy endpoint.
 *
 * Normal entries are batched and flushed on a 2-second interval.
 * Critical entries (errors) trigger an immediate flush.
 * On page unload, remaining entries are sent via navigator.sendBeacon.
 */

import { getState, type LogEntry } from './state';

export type { LogEntry } from './state';

const ENDPOINT = '/__mindstudio_dev__/logs';
const FLUSH_INTERVAL = 2000;

/**
 * Register a function that returns the current WebSocket (or null).
 * Called by ws-client after initialization.
 */
export function setWsGetter(fn: () => WebSocket | null): void {
  getState().transport.wsGetter = fn;
}

function flush(): void {
  const s = getState().transport;
  if (s.buffer.length === 0) {
    return;
  }
  const entries = s.buffer;
  s.buffer = [];

  // Prefer WebSocket when available
  const ws = s.wsGetter?.();
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify({ type: 'log', entries }));
      return;
    } catch {
      // Fall through to XHR
    }
  }

  // Fallback to XHR (during reconnect gaps)
  try {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', ENDPOINT, true);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.send(JSON.stringify(entries));
  } catch {
    // Best effort — don't crash the app
  }
}

function scheduleFlush(): void {
  const s = getState().transport;
  if (s.flushTimer) {
    return;
  }
  s.flushTimer = setTimeout(() => {
    s.flushTimer = null;
    flush();
  }, FLUSH_INTERVAL);
}

function flushNow(): void {
  const s = getState().transport;
  if (s.flushTimer) {
    clearTimeout(s.flushTimer);
    s.flushTimer = null;
  }
  flush();
}

/**
 * Add an entry to the buffer. Flushed on the next interval.
 */
export function push(entry: LogEntry): void {
  const s = getState().transport;
  s.buffer.push(entry);
  if (s.capturing) {
    s.captured.push(entry);
  }
  scheduleFlush();
}

/**
 * Add an entry and flush immediately. Use for critical events (errors).
 */
export function pushAndFlush(entry: LogEntry): void {
  const s = getState().transport;
  s.buffer.push(entry);
  if (s.capturing) {
    s.captured.push(entry);
  }
  flushNow();
}

/**
 * Start capturing log entries. Call before a command batch executes.
 */
export function startCapture(): void {
  const s = getState().transport;
  s.capturing = true;
  s.captured = [];
}

/**
 * Stop capturing and return all entries collected since startCapture().
 */
export function stopCapture(): LogEntry[] {
  const s = getState().transport;
  s.capturing = false;
  const result = s.captured;
  s.captured = [];
  return result;
}

/**
 * Set up the beforeunload handler to flush remaining entries via sendBeacon.
 */
export function initTransport(): void {
  window.addEventListener('beforeunload', () => {
    const s = getState().transport;
    if (s.buffer.length > 0 && navigator.sendBeacon) {
      navigator.sendBeacon(ENDPOINT, JSON.stringify(s.buffer));
    }
  });
}
