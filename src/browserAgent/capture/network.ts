/**
 * Network capture — monkey-patches window.fetch to log all requests.
 * Logs both successful and failed requests so the agent can see the full
 * picture of what the app is doing.
 */

import { push } from '../transport';
import type { LogEntry } from '../protocol';
import { trackRequestStart, trackRequestEnd } from '../network-idle';

export function initNetworkCapture(): void {
  if (!window.fetch) {
    return;
  }
  if ((window.fetch as any).__ms_patched) {
    return;
  }

  const originalFetch = window.fetch;

  window.fetch = function (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const method = (init?.method || 'GET').toUpperCase();
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url || String(input);

    // Skip our own log endpoint to avoid infinite loops
    if (url.includes('/__mindstudio_dev__/')) {
      return originalFetch.apply(this, [input, init] as Parameters<
        typeof fetch
      >);
    }

    const startTime = Date.now();
    trackRequestStart();

    let pending: Promise<Response>;
    try {
      pending = originalFetch.apply(this, [input, init] as Parameters<
        typeof fetch
      >);
    } catch (err) {
      // fetch() threw synchronously (e.g. malformed input, some CSP paths)
      // rather than rejecting. Without this, the `.then(end, end)` below never
      // attaches, so trackRequestEnd() is never called and the in-flight count
      // leaks +1 permanently — pinning network-idle above zero and degrading
      // every future snapshot to the full waitForNetworkIdle timeout.
      trackRequestEnd();
      throw err;
    }

    return pending.then(
      (response) => {
        trackRequestEnd();

        const entry: LogEntry = {
          type: 'network',
          method,
          url,
          status: response.status,
          statusText: response.statusText,
          duration: Date.now() - startTime,
          ok: response.ok,
        };

        if (!response.ok) {
          // Read response body for failed requests
          try {
            response
              .clone()
              .text()
              .then((body) => {
                entry.body = body.slice(0, 1000);
                push(entry);
              })
              .catch(() => push(entry));
          } catch {
            push(entry);
          }
        } else {
          push(entry);
        }

        return response;
      },
      (err) => {
        trackRequestEnd();

        push({
          type: 'network',
          method,
          url,
          error: err.message || String(err),
          duration: Date.now() - startTime,
          ok: false,
        });
        throw err;
      },
    );
  };
  (window.fetch as any).__ms_patched = true;
}
