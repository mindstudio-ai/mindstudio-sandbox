/**
 * Console capture — overrides console.log/info/warn/error/debug.
 * Calls the original methods through so browser devtools still work.
 */

import { push } from '../transport';
import { serialize } from '../utils';

const LEVELS = ['log', 'info', 'warn', 'error', 'debug'] as const;

export function initConsoleCapture(): void {
  if ((console as any).__ms_patched) {
    return;
  }
  (console as any).__ms_patched = true;

  for (const level of LEVELS) {
    const original = console[level];
    console[level] = (...args: unknown[]) => {
      if (original) {
        original.apply(console, args);
      }
      push({
        type: 'console',
        level,
        args: args.map(serialize),
        url: location.href,
      });
    };
  }
}
