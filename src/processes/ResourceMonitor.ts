/**
 * Resource monitor — collects memory and CPU metrics for all tracked
 * processes and the container as a whole. Polls on an interval and
 * broadcasts snapshots to WebSocket clients.
 *
 * Uses /proc filesystem on Linux for child process metrics and cgroup
 * for container limits. Gracefully returns nulls on non-Linux platforms.
 */

import fsSync from 'node:fs';
import os from 'node:os';
export interface ProcessResourceMetrics {
  /** Resident memory of the process AND every descendant, in bytes. */
  rss: number | null;
  heapUsed: number | null;
  heapTotal: number | null;
  /** CPU percent of the process and every descendant. */
  cpu: number | null;
  /** Processes in the tree (1 = no children). Absent for the main process. */
  processCount?: number;
}

export interface SystemResourceMetrics {
  timestamp: number;
  container: {
    memoryLimit: number | null;
    memoryUsage: number | null;
    memoryPercent: number | null;
  };
  processes: Record<string, ProcessResourceMetrics>;
}
import type { ProcessRegistry } from './ProcessRegistry.js';
import { createLogger } from '../logger.js';

const log = createLogger('monitor');

const DEFAULT_INTERVAL_MS = 5_000;

interface CpuSample {
  userMs: number;
  systemMs: number;
  timestamp: number;
}

export interface ResourceMonitorOpts {
  registry: ProcessRegistry;
  onSnapshot: (snapshot: SystemResourceMetrics) => void;
  intervalMs?: number;
}

export class ResourceMonitor {
  private registry: ProcessRegistry;
  private onSnapshot: (snapshot: SystemResourceMetrics) => void;
  private timer: ReturnType<typeof setInterval> | null = null;
  private cpuSamples = new Map<string, CpuSample>();
  private containerMemoryLimit: number | null = null;
  /**
   * PIDs tracked outside the ProcessRegistry (e.g. sandbox-hosted Chrome,
   * owned by the tunnel). Chrome is Memory-hungry (~150-300 MB baseline)
   * so surfacing it in resource metrics is valuable for debugging OOMs.
   */
  private externalPids = new Map<string, number>();

  constructor(opts: ResourceMonitorOpts) {
    this.registry = opts.registry;
    this.onSnapshot = opts.onSnapshot;
    this.containerMemoryLimit = readContainerMemoryLimit();
    if (this.containerMemoryLimit) {
      log.info(
        `Container memory limit: ${Math.round(this.containerMemoryLimit / 1024 / 1024)}MB`,
      );
    }

    const interval = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.timer = setInterval(() => this.collect(), interval);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Force an immediate collection + broadcast. */
  collectNow(): SystemResourceMetrics {
    return this.collect();
  }

  /** Track an externally-owned PID (e.g. sandbox Chrome). */
  trackExternalPid(name: string, pid: number): void {
    this.externalPids.set(name, pid);
  }

  /** Stop tracking an externally-owned PID. */
  untrackExternalPid(name: string): void {
    this.externalPids.delete(name);
    this.cpuSamples.delete(name);
  }

  private collect(): SystemResourceMetrics {
    const processes: Record<string, ProcessResourceMetrics> = {};
    // One /proc scan per tick, shared by every tracked root below.
    const tree = readProcessTree();

    for (const info of this.registry.getAllInfo()) {
      if (info.name === 'system') {
        // Main Node.js process — use process.memoryUsage()
        processes[info.name] = this.collectMainProcess();
      } else if (
        info.pid &&
        (info.state === 'running' || info.state === 'starting')
      ) {
        processes[info.name] = this.collectProcessTree(
          info.name,
          info.pid,
          tree,
        );
      }
    }

    // External PIDs (e.g. sandbox-hosted Chrome owned by the tunnel).
    for (const [name, pid] of this.externalPids) {
      processes[name] = this.collectProcessTree(name, pid, tree);
    }

    // Clean up CPU samples for processes no longer running
    for (const name of this.cpuSamples.keys()) {
      if (!processes[name]) {
        this.cpuSamples.delete(name);
      }
    }

    const containerUsage = readContainerMemoryUsage();

    const snapshot: SystemResourceMetrics = {
      timestamp: Date.now(),
      container: {
        memoryLimit: this.containerMemoryLimit,
        memoryUsage: containerUsage,
        memoryPercent:
          this.containerMemoryLimit && containerUsage
            ? Math.round((containerUsage / this.containerMemoryLimit) * 1000) /
              10
            : null,
      },
      processes,
    };

    this.onSnapshot(snapshot);
    return snapshot;
  }

  private collectMainProcess(): ProcessResourceMetrics {
    const mem = process.memoryUsage();
    const cpu = this.calculateCpuPercent('system', {
      userMs: process.cpuUsage().user / 1000,
      systemMs: process.cpuUsage().system / 1000,
    });

    return {
      rss: mem.rss,
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      cpu,
    };
  }

  /**
   * Metrics for a tracked root PID plus every descendant. The children are
   * where the memory actually is: tsserver under the language server, Chrome's
   * renderer/GPU/utility processes under the browser, the methods worker under
   * the tunnel. Reading only the root (as this used to) hid ~3 GB of leaked
   * tsservers in RPT-1213 while the container figure said the box was full.
   */
  private collectProcessTree(
    name: string,
    pid: number,
    tree: ProcessTree | null,
  ): ProcessResourceMetrics {
    const result: ProcessResourceMetrics = {
      rss: null,
      heapUsed: null,
      heapTotal: null,
      cpu: null,
    };

    const pids = tree ? collectDescendants(pid, tree) : [pid];
    let rss = 0;
    let sawRss = false;
    let userMs = 0;
    let systemMs = 0;
    let sawCpu = false;
    for (const p of pids) {
      const r = readProcRss(p);
      if (r !== null) {
        rss += r;
        sawRss = true;
      }
      const c = readProcCpuMs(p);
      if (c) {
        userMs += c.userMs;
        systemMs += c.systemMs;
        sawCpu = true;
      }
    }

    if (sawRss) {
      result.rss = rss;
    }
    if (sawCpu) {
      result.cpu = this.calculateCpuPercent(name, { userMs, systemMs });
    }
    result.processCount = pids.length;
    return result;
  }

  private calculateCpuPercent(
    name: string,
    current: { userMs: number; systemMs: number },
  ): number | null {
    const prev = this.cpuSamples.get(name);
    const now = Date.now();
    this.cpuSamples.set(name, { ...current, timestamp: now });

    if (!prev) {
      return null; // Need two samples
    }

    const elapsed = now - prev.timestamp;
    if (elapsed < 100) {
      return null; // Too close together
    }

    // Cumulative ticks are summed over a process tree, so a child exiting
    // between samples makes the total go backwards. Clamp instead of
    // reporting a negative percentage.
    const cpuDelta = Math.max(
      0,
      current.userMs - prev.userMs + (current.systemMs - prev.systemMs),
    );
    return Math.round((cpuDelta / elapsed) * 1000) / 10; // One decimal place
  }
}

// --- /proc process tree ---

/** ppid → child pids, from one scan of /proc. */
type ProcessTree = Map<number, number[]>;

function readProcessTree(): ProcessTree | null {
  let entries: string[];
  try {
    entries = fsSync.readdirSync('/proc');
  } catch {
    return null; // not Linux / no procfs
  }
  const tree: ProcessTree = new Map();
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) {
      continue;
    }
    const pid = parseInt(entry, 10);
    const ppid = readProcPpid(pid);
    if (ppid === null) {
      continue;
    }
    const children = tree.get(ppid);
    if (children) {
      children.push(pid);
    } else {
      tree.set(ppid, [pid]);
    }
  }
  return tree;
}

/** The root and every transitive child known to `tree`. */
function collectDescendants(root: number, tree: ProcessTree): number[] {
  const out = [root];
  const stack = [root];
  while (stack.length > 0) {
    const pid = stack.pop()!;
    for (const child of tree.get(pid) ?? []) {
      out.push(child);
      stack.push(child);
    }
  }
  return out;
}

/**
 * /proc/<pid>/stat fields after the `)` that closes comm — comm itself can
 * contain spaces and parens, so split only what follows it. Indices from
 * there: [0]=state, [1]=ppid, [11]=utime, [12]=stime.
 */
function readProcStatFields(pid: number): string[] | null {
  try {
    const stat = fsSync.readFileSync(`/proc/${pid}/stat`, 'utf-8');
    const closeParen = stat.lastIndexOf(')');
    if (closeParen === -1) {
      return null;
    }
    return stat.slice(closeParen + 2).split(' ');
  } catch {
    return null; // process gone between readdir and read
  }
}

function readProcPpid(pid: number): number | null {
  const fields = readProcStatFields(pid);
  if (!fields) {
    return null;
  }
  const ppid = parseInt(fields[1], 10);
  return Number.isFinite(ppid) ? ppid : null;
}

function readProcCpuMs(
  pid: number,
): { userMs: number; systemMs: number } | null {
  const fields = readProcStatFields(pid);
  if (!fields) {
    return null;
  }
  const utime = parseInt(fields[11], 10);
  const stime = parseInt(fields[12], 10);
  if (!Number.isFinite(utime) || !Number.isFinite(stime)) {
    return null;
  }
  const ticksPerSecond = 100; // sysconf(_SC_CLK_TCK) is almost always 100
  return {
    userMs: (utime / ticksPerSecond) * 1000,
    systemMs: (stime / ticksPerSecond) * 1000,
  };
}

/** VmRSS from /proc/<pid>/status, in bytes. */
function readProcRss(pid: number): number | null {
  try {
    const status = fsSync.readFileSync(`/proc/${pid}/status`, 'utf-8');
    for (const line of status.split('\n')) {
      const match = line.match(/^VmRSS:\s+(\d+)/);
      if (match) {
        return parseInt(match[1], 10) * 1024; // KB → bytes
      }
    }
  } catch {
    // process gone or /proc unavailable
  }
  return null;
}

// --- Container metrics (cgroup) ---

function readContainerMemoryLimit(): number | null {
  // Try cgroup v2 first
  try {
    const val = fsSync
      .readFileSync('/sys/fs/cgroup/memory.max', 'utf-8')
      .trim();
    if (val !== 'max') {
      return parseInt(val, 10);
    }
  } catch {}

  // Fall back to cgroup v1
  try {
    const val = fsSync
      .readFileSync('/sys/fs/cgroup/memory/memory.limit_in_bytes', 'utf-8')
      .trim();
    const limit = parseInt(val, 10);
    // Cgroup v1 returns a huge number if no limit set
    if (limit < os.totalmem() * 2) {
      return limit;
    }
  } catch {}

  // No cgroup cap: the sandbox is a microVM whose RAM is the real ceiling
  // (cgroup v2 reports `max`). Total memory is that ceiling, and without it
  // `memoryPercent` was always null — the container gauge never rendered.
  const total = os.totalmem();
  return total > 0 ? total : null;
}

function readContainerMemoryUsage(): number | null {
  // Try cgroup v2 first
  try {
    return parseInt(
      fsSync.readFileSync('/sys/fs/cgroup/memory.current', 'utf-8').trim(),
      10,
    );
  } catch {}

  // Fall back to cgroup v1
  try {
    return parseInt(
      fsSync
        .readFileSync('/sys/fs/cgroup/memory/memory.usage_in_bytes', 'utf-8')
        .trim(),
      10,
    );
  } catch {}

  return null;
}
