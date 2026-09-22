/**
 * Centralized structured logger with level filtering and event hooks.
 *
 * Usage:
 *   import { createLogger } from './logger.ts';
 *   const log = createLogger('my-module');
 *   log.info('Server started');
 *   log.info('Tool resolved', { requestId: 'ac-4', toolCallId: 'toolu_abc' });
 *
 * Levels (in order): debug < info < warn < error
 * Set via LOG_LEVEL env var or setLogLevel(). Default: 'info'.
 *
 * Output is NDJSON, one object per line, written to the SINK. By default that is
 * stdout (stderr for `error`) — what the cluster's log forwarder scrapes off the
 * C&C. The dev tunnel points it at stderr instead, because its stdout is the
 * NDJSON protocol channel to the C&C; see `devTunnel/logging/logger.ts`, which
 * is how every tunnel module reaches this one. Register onLog() listeners to
 * pipe log entries into registries, ring buffers, or external log collectors.
 *
 * ## Two levels, on purpose
 *
 * The two outputs have different audiences and different costs, so they have
 * separate thresholds:
 *
 *   - LISTENERS (`LOG_LEVEL`, default debug) feed the editor's log pane via the
 *     `system` pseudo-process. This is somebody actively debugging a box, and
 *     debug detail is the reason they opened it.
 *   - THE SINK (`STDOUT_LOG_LEVEL`, default info) is scraped by the cluster's
 *     log forwarder and shipped off-box. One debug line here is not one line: at
 *     2026-09-19 a single `log.debug('Agent event')` was 2.19M lines/day, 57% of
 *     the entire platform's log volume, which is how it drowned out the 413k
 *     lines the platform emits about itself.
 *
 * So `log.debug` still reaches the person looking at the box, and stops being
 * billed, indexed and searched by everyone else. Raise STDOUT_LOG_LEVEL to
 * 'debug' on a box you are debugging remotely.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogContext {
  requestId?: string;
  toolCallId?: string;
  [key: string]: unknown;
}

export interface LogEntry {
  level: LogLevel;
  module: string;
  message: string;
  ts: number;
  ctx?: LogContext;
}

export interface Logger {
  debug(msg: string, ctx?: LogContext): void;
  info(msg: string, ctx?: LogContext): void;
  warn(msg: string, ctx?: LogContext): void;
  error(msg: string, ctx?: LogContext): void;
}

/** Where a formatted NDJSON line goes. Receives the line without its newline. */
export type LogSink = (line: string, level: LogLevel) => void;

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const VALID_LOG_LEVELS: readonly LogLevel[] = [
  'debug',
  'info',
  'warn',
  'error',
];

/**
 * Parse an env-var value into a level, falling back when it is unset or not a
 * level. Both processes read `LOG_LEVEL` through this, so they disagree only in
 * the fallback they choose.
 */
export function parseLogLevel(
  raw: string | undefined,
  fallback: LogLevel,
): LogLevel {
  const value = raw?.toLowerCase();
  return VALID_LOG_LEVELS.includes(value as LogLevel)
    ? (value as LogLevel)
    : fallback;
}

const stdoutSink: LogSink = (line, level) => {
  if (level === 'error') {
    console.error(line);
  } else {
    console.log(line);
  }
};

let currentLevel: LogLevel = 'info';
let sinkLevel: LogLevel = 'info';
let sink: LogSink = stdoutSink;
const listeners = new Set<(entry: LogEntry) => void>();

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export function getLogLevel(): LogLevel {
  return currentLevel;
}

/**
 * The threshold for the sink only — see the header. Never below `currentLevel`
 * in effect, since an entry filtered there never reaches here.
 */
export function setSinkLogLevel(level: LogLevel): void {
  sinkLevel = level;
}

export function getSinkLogLevel(): LogLevel {
  return sinkLevel;
}

/** Replace the default stdout sink. Listeners are unaffected. */
export function setLogSink(next: LogSink): void {
  sink = next;
}

/** Register a listener for all log entries that pass the level filter. */
export function onLog(handler: (entry: LogEntry) => void): () => void {
  listeners.add(handler);
  return () => {
    listeners.delete(handler);
  };
}

/** Create a tagged logger for a specific module. */
export function createLogger(module: string): Logger {
  function emit(level: LogLevel, msg: string, ctx?: LogContext): void {
    if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[currentLevel]) {
      return;
    }

    if (LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[sinkLevel]) {
      sink(
        JSON.stringify({
          ts: Date.now(),
          level,
          module,
          msg,
          ...ctx,
        }),
        level,
      );
    }

    const entry: LogEntry = { level, module, message: msg, ts: Date.now() };
    if (ctx) {
      entry.ctx = ctx;
    }
    for (const listener of listeners) {
      try {
        listener(entry);
      } catch {
        // Don't let a broken listener crash the logger
      }
    }
  }

  return {
    debug: (msg: string, ctx?: LogContext) => emit('debug', msg, ctx),
    info: (msg: string, ctx?: LogContext) => emit('info', msg, ctx),
    warn: (msg: string, ctx?: LogContext) => emit('warn', msg, ctx),
    error: (msg: string, ctx?: LogContext) => emit('error', msg, ctx),
  };
}
