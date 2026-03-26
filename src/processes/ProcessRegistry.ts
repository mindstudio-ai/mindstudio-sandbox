/**
 * Unified process registry — central data store for all process metadata.
 * Logs are written to individual files on disk (.logs/<process>.log).
 */

import fs from 'node:fs';
import path from 'node:path';

export type ProcessType = 'service' | 'task' | 'shell' | 'system' | 'pty';
export type ProcessState =
  | 'starting'
  | 'running'
  | 'crashed'
  | 'stopped'
  | 'completed';

export interface RestartRecord {
  at: number;
  exitCode: number | null;
  signal: string | null;
}

export interface ProcessInfo {
  name: string;
  type: ProcessType;
  command: string;
  state: ProcessState;
  startedAt: number | null;
  endedAt: number | null;
  duration: number | null;
  exitCode: number | null;
  signal: string | null;
  restartCount: number;
  restartHistory: RestartRecord[];
  pid: number | null;
  logFile: string;
}

export interface ProcessStateChangeEvent {
  name: string;
  type: ProcessType;
  prevState: ProcessState;
  state: ProcessState;
  exitCode?: number | null;
  signal?: string | null;
  pid?: number | null;
  restartCount?: number;
  timestamp: number;
}

export interface ProcessSnapshot {
  info: ProcessInfo;
}

const MAX_RESTART_HISTORY = 20;
const MAX_LOG_SIZE = 2 * 1024 * 1024; // 2MB per log file
const ROTATION_CHECK_INTERVAL = 500; // only check file size every N appends

interface RegistryEntry {
  info: ProcessInfo;
  appendCount: number;
}

export interface ProcessRegistryOpts {
  onStateChange: (event: ProcessStateChangeEvent) => void;
  logsDir: string;
}

export class ProcessRegistry {
  private entries = new Map<string, RegistryEntry>();
  private onStateChange: (event: ProcessStateChangeEvent) => void;
  private logsDir: string;

  constructor(opts: ProcessRegistryOpts) {
    this.onStateChange = opts.onStateChange;
    this.logsDir = opts.logsDir;
  }

  register(name: string, type: ProcessType, command: string): void {
    // Sanitize name for filename (replace colons, slashes, etc.)
    const safeFilename = name.replace(/[^a-zA-Z0-9_-]/g, '_');
    const logFile = `.logs/${safeFilename}.ndjson`;

    this.entries.set(name, {
      info: {
        name,
        type,
        command,
        state: 'starting',
        startedAt: Date.now(),
        endedAt: null,
        duration: null,
        exitCode: null,
        signal: null,
        restartCount: 0,
        restartHistory: [],
        pid: null,
        logFile,
      },
      appendCount: 0,
    });
  }

  setState(
    name: string,
    state: ProcessState,
    extras?: {
      exitCode?: number | null;
      signal?: string | null;
      pid?: number | null;
    },
  ): void {
    const entry = this.entries.get(name);
    if (!entry) {
      return;
    }

    const prevState = entry.info.state;
    entry.info.state = state;

    if (extras?.exitCode !== undefined) {
      entry.info.exitCode = extras.exitCode;
    }
    if (extras?.signal !== undefined) {
      entry.info.signal = extras.signal;
    }
    if (extras?.pid !== undefined) {
      entry.info.pid = extras.pid;
    }

    // Track restart: if transitioning from crashed → starting, record the crash
    if (state === 'starting' && prevState === 'crashed') {
      entry.info.restartCount++;
      entry.info.restartHistory.push({
        at: Date.now(),
        exitCode: entry.info.exitCode,
        signal: entry.info.signal,
      });
      if (entry.info.restartHistory.length > MAX_RESTART_HISTORY) {
        entry.info.restartHistory.shift();
      }
      // Reset for new run
      entry.info.startedAt = Date.now();
      entry.info.endedAt = null;
      entry.info.duration = null;
      entry.info.exitCode = null;
      entry.info.signal = null;
      entry.info.pid = null;
    }

    // Terminal states: compute duration
    if (state === 'crashed' || state === 'stopped' || state === 'completed') {
      entry.info.endedAt = Date.now();
      if (entry.info.startedAt) {
        entry.info.duration = entry.info.endedAt - entry.info.startedAt;
      }
    }

    this.onStateChange({
      name,
      type: entry.info.type,
      prevState,
      state,
      exitCode: entry.info.exitCode,
      signal: entry.info.signal,
      pid: entry.info.pid,
      restartCount: entry.info.restartCount,
      timestamp: Date.now(),
    });
  }

  appendLog(name: string, line: string, ctx?: Record<string, unknown>): void {
    const entry = this.entries.get(name);
    if (!entry) {
      return;
    }

    // If the line is already NDJSON (from a process that emits structured
    // logs), pass it through as-is instead of double-wrapping it.
    let record: string;
    if (line.startsWith('{') && line.endsWith('}')) {
      record = line;
    } else {
      record = JSON.stringify({ ts: Date.now(), msg: line, ...ctx });
    }
    const fullPath = path.join(this.logsDir, path.basename(entry.info.logFile));
    try {
      fs.appendFileSync(fullPath, record + '\n');
      entry.appendCount++;
      if (entry.appendCount % ROTATION_CHECK_INTERVAL === 0) {
        this.maybeRotate(fullPath);
      }
    } catch {
      // Ignore write failures (dir might not exist yet during early bootstrap)
    }
  }

  /** Truncate log file if it exceeds the size cap. */
  private maybeRotate(fullPath: string): void {
    try {
      const stat = fs.statSync(fullPath);
      if (stat.size > MAX_LOG_SIZE) {
        fs.writeFileSync(fullPath, '');
      }
    } catch {
      // ignore
    }
  }

  getInfo(name: string): ProcessInfo | undefined {
    return this.entries.get(name)?.info;
  }

  getAllInfo(): ProcessInfo[] {
    return Array.from(this.entries.values()).map((e) => e.info);
  }

  /** Get the relative log file path for a process (for HTTP endpoint). */
  getLogPath(name: string): string | undefined {
    return this.entries.get(name)?.info.logFile;
  }

  /** Snapshot all entries for persistence (metadata only, logs are on disk). */
  getSnapshots(): ProcessSnapshot[] {
    return Array.from(this.entries.values()).map((e) => ({
      info: { ...e.info, restartHistory: [...e.info.restartHistory] },
    }));
  }

  /** Restore from persisted snapshots. Service processes get marked as stopped. */
  hydrate(snapshots: ProcessSnapshot[]): void {
    for (const snap of snapshots) {
      const info = { ...snap.info };
      // Processes from a previous VM are no longer running
      if (info.state === 'running' || info.state === 'starting') {
        info.state = 'stopped';
        info.endedAt = info.endedAt ?? Date.now();
        if (info.startedAt) {
          info.duration = info.endedAt - info.startedAt;
        }
      }
      this.entries.set(info.name, { info, appendCount: 0 });
    }
  }

  remove(name: string): void {
    this.entries.delete(name);
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }
}
