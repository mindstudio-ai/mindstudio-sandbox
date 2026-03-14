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
import type {
  ProcessResourceMetrics,
  SystemResourceMetrics,
} from '../types.js';
import type { ProcessRegistry } from './process-registry.js';
import { createLogger } from '../logger.js';

const log = createLogger('resource-monitor');

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

  private collect(): SystemResourceMetrics {
    const processes: Record<string, ProcessResourceMetrics> = {};

    for (const info of this.registry.getAllInfo()) {
      if (info.name === 'system') {
        // Main Node.js process — use process.memoryUsage()
        processes[info.name] = this.collectMainProcess();
      } else if (
        info.pid &&
        (info.state === 'running' || info.state === 'starting')
      ) {
        processes[info.name] = this.collectChildProcess(info.name, info.pid);
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

  private collectChildProcess(
    name: string,
    pid: number,
  ): ProcessResourceMetrics {
    const result: ProcessResourceMetrics = {
      rss: null,
      heapUsed: null,
      heapTotal: null,
      cpu: null,
    };

    try {
      // Read RSS from /proc/{pid}/status
      const status = fsSync.readFileSync(`/proc/${pid}/status`, 'utf-8');
      for (const line of status.split('\n')) {
        const match = line.match(/^VmRSS:\s+(\d+)/);
        if (match) {
          result.rss = parseInt(match[1], 10) * 1024; // KB → bytes
          break;
        }
      }

      // Read CPU from /proc/{pid}/stat
      const stat = fsSync.readFileSync(`/proc/${pid}/stat`, 'utf-8');
      // Fields are space-delimited, but comm (field 2) can contain spaces and parens
      // Safe approach: find the closing paren, then split the rest
      const closeParen = stat.lastIndexOf(')');
      if (closeParen !== -1) {
        const fields = stat.slice(closeParen + 2).split(' ');
        // fields[11] = utime, fields[12] = stime (0-indexed after state field)
        const utime = parseInt(fields[11], 10);
        const stime = parseInt(fields[12], 10);
        const ticksPerSecond = 100; // sysconf(_SC_CLK_TCK) is almost always 100
        result.cpu = this.calculateCpuPercent(name, {
          userMs: (utime / ticksPerSecond) * 1000,
          systemMs: (stime / ticksPerSecond) * 1000,
        });
      }
    } catch {
      // Process doesn't exist or /proc not available — return nulls
    }

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

    const cpuDelta =
      current.userMs - prev.userMs + (current.systemMs - prev.systemMs);
    return Math.round((cpuDelta / elapsed) * 1000) / 10; // One decimal place
  }
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

  return null;
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
