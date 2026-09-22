/**
 * NDJSON log for browser-side events (console, errors, network, clicks).
 * Thin wrapper around NdjsonLog.
 */

import { NdjsonLog } from './ndjson-log.ts';
import type { LogEntry } from '../../browserAgent/protocol.ts';

const ndjsonLog = new NdjsonLog('browser.ndjson');

export function initBrowserLog(projectRoot: string): void {
  ndjsonLog.init(projectRoot);
}

/** Map browser entry types to log levels. */
function inferLevel(entry: LogEntry): string {
  if (entry.type === 'error') {
    return 'error';
  }
  const level = entry.level;
  if (level === 'warn' || level === 'error' || level === 'debug') {
    return level;
  }
  return 'info';
}

export function appendBrowserLogEntries(entries: LogEntry[]): void {
  for (const entry of entries) {
    ndjsonLog.append({
      ts: Date.now(),
      level: inferLevel(entry),
      module: 'browser',
      ...entry,
    });
  }
}

export function closeBrowserLog(): void {
  ndjsonLog.close();
}
