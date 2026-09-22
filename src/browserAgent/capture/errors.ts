/**
 * Error capture — uncaught JS errors and unhandled promise rejections.
 * Flushes immediately since errors are critical.
 */

import { pushAndFlush } from '../transport';

export function initErrorCapture(): void {
  if ((window as any).__ms_error_patched) {
    return;
  }
  (window as any).__ms_error_patched = true;

  window.addEventListener('error', (e: ErrorEvent) => {
    pushAndFlush({
      type: 'error',
      message: e.message,
      stack: e.error ? e.error.stack || '' : '',
      source: e.filename,
      line: e.lineno,
      column: e.colno,
      url: location.href,
    });
  });

  window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
    const reason = e.reason || {};
    pushAndFlush({
      type: 'error',
      message: reason.message || String(reason),
      stack: reason.stack || '',
      url: location.href,
    });
  });
}
