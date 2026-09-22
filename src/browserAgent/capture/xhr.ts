/**
 * XMLHttpRequest capture — monkey-patches XHR to log requests.
 * Some libraries (SWR, axios) can use XHR instead of fetch.
 */

import { push } from '../transport';
import { trackRequestStart, trackRequestEnd } from '../network-idle';

export function initXhrCapture(): void {
  if ((XMLHttpRequest.prototype.open as any).__ms_patched) {
    return;
  }

  const OriginalXHR = window.XMLHttpRequest;

  const originalOpen = OriginalXHR.prototype.open;
  const originalSend = OriginalXHR.prototype.send;

  OriginalXHR.prototype.open = function (
    method: string,
    url: string | URL,
    ...rest: any[]
  ) {
    (this as any).__ms_method = method.toUpperCase();
    (this as any).__ms_url = String(url);
    return originalOpen.apply(this, [method, url, ...rest] as any);
  };

  OriginalXHR.prototype.send = function (body?: any) {
    const method: string = (this as any).__ms_method || 'GET';
    const url: string = (this as any).__ms_url || '';

    // Skip our own endpoints
    if (url.includes('/__mindstudio_dev__/')) {
      return originalSend.apply(this, [body] as any);
    }

    const startTime = Date.now();
    trackRequestStart();

    this.addEventListener(
      'loadend',
      function () {
        trackRequestEnd();

        push({
          type: 'network',
          method,
          url,
          status: this.status,
          statusText: this.statusText,
          duration: Date.now() - startTime,
          ok: this.status >= 200 && this.status < 300,
          ...(this.status >= 400
            ? { body: (this.responseText || '').slice(0, 1000) }
            : {}),
          via: 'xhr',
        });
      },
      { once: true },
    );

    return originalSend.apply(this, [body] as any);
  };

  (XMLHttpRequest.prototype.open as any).__ms_patched = true;
}
