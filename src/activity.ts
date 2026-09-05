/**
 * Session activity — what "in use" actually looks like, as counts over time.
 *
 * The individual events are already logged at debug by the modules that handle them, but a stream
 * of per-request lines cannot answer the question this exists for: is this box being used, and if
 * not, for how long. That is the input to a dev-box reaping policy, and the reason it has to live
 * HERE is that nothing else can see it — the editor connects straight to this box's C&C domain
 * (LSP, WebSocket, HMR, preview), so CFES is not in the request path once a session is running.
 * From outside, a box mid-session and a box someone closed the tab on look identical.
 *
 * Deliberately counts, not events. Five kinds, recorded at five chokepoints, reported once a
 * minute. That is enough to distinguish "typing", "watching a preview reload", "an agent turn is
 * running" and "nobody is here", which is the distinction a policy needs.
 */

import { createLogger } from './logger.js';

const log = createLogger('activity');

const REPORT_INTERVAL_MS = 60_000;

/**
 * What kind of use this was.
 *
 * `ws` covers every editor command (files, shell, pty, search, agent actions) because they all
 * dispatch through one action map. `lsp` is separate because completions and hovers bypass that map
 * on their own socket, and they are the highest-frequency thing a person typing produces. `fs` is
 * the box's OWN file changes — an agent writing, a git operation — which is activity with no user
 * request behind it, and a reaper that only watched inbound traffic would kill a box mid-agent-turn.
 */
export type ActivityKind = 'ws' | 'lsp' | 'hmr' | 'fs' | 'http';

const KINDS: ActivityKind[] = ['ws', 'lsp', 'hmr', 'fs', 'http'];

const zero = (): Record<ActivityKind, number> => ({
  ws: 0,
  lsp: 0,
  hmr: 0,
  fs: 0,
  http: 0,
});

let counts = zero();
let lastActivityAt = Date.now();
let reportedIdle = false;
let timer: ReturnType<typeof setInterval> | null = null;

/**
 * Record one unit of use. Called from hot paths (every keystroke produces LSP traffic), so it stays
 * two field writes and nothing else — no allocation, no logging, no timestamp formatting.
 */
export function recordActivity(kind: ActivityKind): void {
  counts[kind] += 1;
  lastActivityAt = Date.now();
}

/**
 * Start the once-a-minute reporter. Returns a stop function.
 *
 * An idle box logs ONCE per idle streak and then goes quiet. Repeating `idle 5m` / `idle 6m` every
 * minute for an abandoned box would be the bulk of the log volume and would train everyone to
 * filter the line out — taking the useful reports with it.
 */
export function startActivityReporter(
  intervalMs = REPORT_INTERVAL_MS,
): () => void {
  const tick = () => {
    const now = Date.now();
    const total = KINDS.reduce((n, k) => n + counts[k], 0);
    const idleSec = Math.round((now - lastActivityAt) / 1000);

    if (total === 0) {
      if (!reportedIdle) {
        reportedIdle = true;
        log.info('Session idle', { idleSec });
      }
      return;
    }

    reportedIdle = false;
    log.info('Session activity', {
      windowSec: Math.round(intervalMs / 1000),
      total,
      ...counts,
      idleSec,
    });
    counts = zero();
  };

  timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}
