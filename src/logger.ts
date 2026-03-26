/**
 * Centralized structured logger with level filtering and event hooks.
 *
 * Usage:
 *   import { createLogger } from './logger.js';
 *   const log = createLogger('my-module');
 *   log.info('Server started');
 *   log.info('Tool resolved', { requestId: 'ac-4', toolCallId: 'toolu_abc' });
 *
 * Levels (in order): debug < info < warn < error
 * Set via LOG_LEVEL env var or setLogLevel(). Default: 'info'.
 *
 * Output is NDJSON on stdout/stderr for structured consumption.
 * Register onLog() listeners to pipe log entries into registries,
 * ring buffers, or external log collectors.
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

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let currentLevel: LogLevel = 'info';
const listeners = new Set<(entry: LogEntry) => void>();

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export function getLogLevel(): LogLevel {
  return currentLevel;
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

    const line = JSON.stringify({
      ts: Date.now(),
      level,
      module,
      msg,
      ...ctx,
    });

    if (level === 'error') {
      console.error(line);
    } else {
      console.log(line);
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
