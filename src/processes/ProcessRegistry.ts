/**
 * Unified process registry — central data store for all process metadata
 * and per-process log buffers. Every execution unit (bootstrap tasks,
 * long-lived services, shell commands, system logs) is a first-class entry.
 */

export type ProcessType = 'service' | 'task' | 'shell' | 'system' | 'pty';
export type ProcessState =
  | 'starting'
  | 'running'
  | 'crashed'
  | 'stopped'
  | 'completed';

export interface ProcessLogEntry {
  stream: 'stdout' | 'stderr';
  line: string;
  ts: number;
}

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
  log: ProcessLogEntry[];
}

const DEFAULT_LOG_CAP = 1000;
const DEFAULT_MERGED_LOG_CAP = 5000;
const MAX_RESTART_HISTORY = 20;

interface RegistryEntry {
  info: ProcessInfo;
  log: ProcessLogEntry[];
}

export interface ProcessRegistryOpts {
  onStateChange: (event: ProcessStateChangeEvent) => void;
  onLogAppend: (name: string, entry: ProcessLogEntry) => void;
  logCap?: number;
  mergedLogCap?: number;
}

export class ProcessRegistry {
  private entries = new Map<string, RegistryEntry>();
  private onStateChange: (event: ProcessStateChangeEvent) => void;
  private onLogAppend: (name: string, entry: ProcessLogEntry) => void;
  private logCap: number;
  private mergedLogCap: number;

  constructor(opts: ProcessRegistryOpts) {
    this.onStateChange = opts.onStateChange;
    this.onLogAppend = opts.onLogAppend;
    this.logCap = opts.logCap ?? DEFAULT_LOG_CAP;
    this.mergedLogCap = opts.mergedLogCap ?? DEFAULT_MERGED_LOG_CAP;
  }

  register(name: string, type: ProcessType, command: string): void {
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
      },
      log: [],
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

  appendLog(name: string, stream: 'stdout' | 'stderr', line: string): void {
    const entry = this.entries.get(name);
    if (!entry) {
      return;
    }

    const logEntry: ProcessLogEntry = { stream, line, ts: Date.now() };
    entry.log.push(logEntry);

    // Per-process cap
    if (entry.log.length > this.logCap) {
      entry.log.splice(0, entry.log.length - this.logCap);
    }

    this.onLogAppend(name, logEntry);
  }

  getInfo(name: string): ProcessInfo | undefined {
    return this.entries.get(name)?.info;
  }

  getAllInfo(): ProcessInfo[] {
    return Array.from(this.entries.values()).map((e) => e.info);
  }

  getLog(name: string): ProcessLogEntry[] {
    return this.entries.get(name)?.log ?? [];
  }

  /** Merged log across all processes, sorted by timestamp, capped. */
  getMergedLog(): ProcessLogEntry[] {
    const all: Array<ProcessLogEntry & { process: string }> = [];
    for (const [name, entry] of this.entries) {
      for (const log of entry.log) {
        all.push({ ...log, process: name });
      }
    }
    all.sort((a, b) => a.ts - b.ts);
    if (all.length > this.mergedLogCap) {
      return all.slice(all.length - this.mergedLogCap);
    }
    return all;
  }

  /** Snapshot all entries for persistence. */
  getSnapshots(): ProcessSnapshot[] {
    return Array.from(this.entries.values()).map((e) => ({
      info: { ...e.info, restartHistory: [...e.info.restartHistory] },
      log: [...e.log],
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
      this.entries.set(info.name, { info, log: [...snap.log] });
    }
  }

  remove(name: string): void {
    this.entries.delete(name);
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }
}
