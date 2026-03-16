/**
 * Centralized logger with level filtering and event hooks.
 *
 * Usage:
 *   import { createLogger } from './logger.js';
 *   const log = createLogger('my-module');
 *   log.info('Server started');
 *   log.debug('Request details...');
 *
 * Levels (in order): debug < info < warn < error
 * Set via LOG_LEVEL env var or setLogLevel(). Default: 'info'.
 *
 * Register onLog() listeners to pipe log entries into WebSocket
 * broadcast, ring buffers, or external log collectors.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  level: LogLevel;
  module: string;
  message: string;
  ts: number;
}

export interface Logger {
  debug(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let currentLevel: LogLevel = 'info';
const listeners = new Set<(entry: LogEntry) => void>();
const startTime = Date.now();

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
  function emit(level: LogLevel, msg: string): void {
    if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[currentLevel]) {
      return;
    }

    const ms = Date.now() - startTime;
    const formatted = `+${ms}ms [${level}] [${module}] ${msg}`;

    switch (level) {
      case 'error':
        console.error(formatted);
        break;
      case 'warn':
        console.warn(formatted);
        break;
      default:
        console.log(formatted);
        break;
    }

    const entry: LogEntry = { level, module, message: msg, ts: Date.now() };
    for (const listener of listeners) {
      try {
        listener(entry);
      } catch {
        // Don't let a broken listener crash the logger
      }
    }
  }

  return {
    debug: (msg: string) => emit('debug', msg),
    info: (msg: string) => emit('info', msg),
    warn: (msg: string) => emit('warn', msg),
    error: (msg: string) => emit('error', msg),
  };
}
