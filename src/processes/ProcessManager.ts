import { spawn, type ChildProcess } from 'node:child_process';
import type {
  ProcessRegistry,
  ProcessState,
  ProcessInfo,
} from './ProcessRegistry.js';
import { attachLineHandler } from './lineSplitter.js';

export interface ManagedProcessConfig {
  name: string;
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  stdin?: boolean;
  restartOnCrash: boolean;
  maxRestarts: number;
  critical?: boolean;
  /** Set to false to skip logging stdout to the process log file (e.g., protocol traffic). */
  logStdout?: boolean;
  onStdout?: (line: string) => void;
  onStderr?: (line: string) => void;
}
import { createLogger } from '../logger.js';

const log = createLogger('procman');

interface ManagedProcess {
  config: ManagedProcessConfig;
  child: ChildProcess | null;
  restartTimer: ReturnType<typeof setTimeout> | null;
  stopped: boolean;
  /**
   * Per-stream line queues. The readline 'line' handler only pushes here
   * and schedules a drain; the actual log append + onStdout/onStderr run
   * on setImmediate so the readline handler never blocks. This is what
   * prevents the agent's stdout pipe buffer from filling and wedging
   * remy's `process.stdout.write`.
   */
  stdoutQueue: string[];
  stdoutDraining: boolean;
  stderrQueue: string[];
  stderrDraining: boolean;
}

export class ProcessManager {
  private processes = new Map<string, ManagedProcess>();
  private registry: ProcessRegistry;

  constructor(registry: ProcessRegistry) {
    this.registry = registry;
  }

  start(config: ManagedProcessConfig): void {
    if (this.processes.has(config.name)) {
      throw new Error(`Process "${config.name}" already registered`);
    }

    const fullCommand = `${config.command} ${config.args.join(' ')}`;
    log.info(`Registering "${config.name}": ${fullCommand}`);
    log.debug(`  "${config.name}" cwd: ${config.cwd}`);
    log.debug(
      `  "${config.name}" restartOnCrash: ${config.restartOnCrash}, maxRestarts: ${config.maxRestarts}`,
    );

    this.registry.register(config.name, 'service', fullCommand);

    const proc: ManagedProcess = {
      config,
      child: null,
      restartTimer: null,
      stopped: false,
      stdoutQueue: [],
      stdoutDraining: false,
      stderrQueue: [],
      stderrDraining: false,
    };

    this.processes.set(config.name, proc);
    this.spawn(proc);
  }

  private spawn(proc: ManagedProcess): void {
    if (proc.stopped) {
      log.debug(`"${proc.config.name}" is stopped, not spawning`);
      return;
    }

    const { config } = proc;
    this.registry.setState(config.name, 'starting');

    log.info(
      `Spawning "${config.name}": ${config.command} ${config.args.join(' ')}`,
    );

    let child: ChildProcess;
    try {
      child = spawn(config.command, config.args, {
        cwd: config.cwd,
        env: { ...process.env, ...config.env },
        stdio: [config.stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      log.error(
        `Failed to spawn "${config.name}": ${err instanceof Error ? err.message : err}`,
      );
      this.registry.setState(config.name, 'crashed');
      return;
    }

    proc.child = child;
    this.registry.setState(config.name, 'running', {
      pid: child.pid ?? null,
    });
    log.info(`"${config.name}" spawned with PID ${child.pid}`);

    if (child.stdout) {
      child.stdout.on('error', (err) => {
        log.error(`"${config.name}" stdout stream error: ${err.message}`);
      });
      attachLineHandler(child.stdout, (line) => {
        proc.stdoutQueue.push(line);
        if (!proc.stdoutDraining) {
          proc.stdoutDraining = true;
          setImmediate(() => this.drainStdout(proc));
        }
      });
    }

    if (child.stderr) {
      child.stderr.on('error', (err) => {
        log.error(`"${config.name}" stderr stream error: ${err.message}`);
      });
      attachLineHandler(child.stderr, (line) => {
        proc.stderrQueue.push(line);
        if (!proc.stderrDraining) {
          proc.stderrDraining = true;
          setImmediate(() => this.drainStderr(proc));
        }
      });
    }

    child.on('exit', (code, signal) => {
      // Drop any unprocessed lines from the previous child. On restart the
      // new readline starts from a clean slate; draining old data would
      // spend CPU + broadcast stale events.
      proc.stdoutQueue.length = 0;
      proc.stderrQueue.length = 0;
      log.info(
        `"${config.name}" (PID ${child.pid}) exited — code=${code}, signal=${signal}`,
      );

      if (proc.stopped) {
        this.registry.setState(config.name, 'stopped', {
          exitCode: code,
          signal: signal ?? undefined,
        });
        log.debug(`"${config.name}" was intentionally stopped`);
        return;
      }

      this.registry.setState(config.name, 'crashed', {
        exitCode: code,
        signal: signal ?? undefined,
      });

      const restartCount =
        this.registry.getInfo(config.name)?.restartCount ?? 0;

      if (config.restartOnCrash && restartCount < config.maxRestarts) {
        const delay = Math.min(1000 * 2 ** restartCount, 30000);
        log.info(
          `Will restart "${config.name}" in ${delay}ms (attempt ${restartCount + 1}/${config.maxRestarts})`,
        );
        proc.restartTimer = setTimeout(() => {
          this.spawn(proc);
        }, delay);
      } else if (restartCount >= config.maxRestarts) {
        log.error(
          `"${config.name}" exceeded max restarts (${config.maxRestarts}), giving up`,
        );
        if (config.critical) {
          log.error(`"${config.name}" is critical — exiting`);
          process.exit(1);
        }
      }
    });

    child.on('error', (err) => {
      const errno = err as NodeJS.ErrnoException;
      log.error(`"${config.name}" spawn error: ${err.message}`);
      log.error(`  code: ${errno.code ?? 'unknown'}`);
      log.error(`  path: ${errno.path ?? 'unknown'}`);
    });
  }

  /**
   * Consume one queued stdout line per event-loop tick, yielding via
   * setImmediate between lines so readline / WS / timers stay responsive
   * during bursts. Critically, this keeps the readline 'line' handler
   * off the critical path — it only appends to the queue, never blocks.
   */
  private drainStdout(proc: ManagedProcess): void {
    const line = proc.stdoutQueue.shift();
    if (line === undefined) {
      proc.stdoutDraining = false;
      return;
    }
    const { config } = proc;
    try {
      if (config.logStdout !== false) {
        const logLine =
          line.length > 2000 ? line.slice(0, 2000) + '… (truncated)' : line;
        this.registry.appendLog(config.name, logLine);
      }
      config.onStdout?.(line);
    } catch (err) {
      log.error(
        `"${config.name}" stdout handler error: ${err instanceof Error ? err.message : err}`,
      );
    }
    if (proc.stdoutQueue.length > 0) {
      setImmediate(() => this.drainStdout(proc));
    } else {
      proc.stdoutDraining = false;
    }
  }

  private drainStderr(proc: ManagedProcess): void {
    const line = proc.stderrQueue.shift();
    if (line === undefined) {
      proc.stderrDraining = false;
      return;
    }
    const { config } = proc;
    try {
      this.registry.appendLog(config.name, line);
      config.onStderr?.(line);
    } catch (err) {
      log.error(
        `"${config.name}" stderr handler error: ${err instanceof Error ? err.message : err}`,
      );
    }
    if (proc.stderrQueue.length > 0) {
      setImmediate(() => this.drainStderr(proc));
    } else {
      proc.stderrDraining = false;
    }
  }

  getState(name: string): ProcessState | undefined {
    return this.registry.getInfo(name)?.state;
  }

  getProcesses(): ProcessInfo[] {
    return this.registry.getAllInfo();
  }

  writeStdin(name: string, data: string): void {
    const proc = this.processes.get(name);
    if (!proc?.child?.stdin) {
      log.error(`writeStdin("${name}"): no stdin available`);
      return;
    }
    if (proc.child.exitCode !== null) {
      log.error(`writeStdin("${name}"): process already exited`);
      return;
    }
    // Escape Unicode line separators (U+2028 / U+2029). These are valid
    // inside JSON string contents and JSON.stringify leaves them as-is,
    // but lax line splitters on the receiving end (we've seen this with
    // remy's headless stdin reader) treat them as line terminators and
    // split a single command across multiple "lines", causing every
    // fragment to fail JSON.parse silently. JSON.parse on the receiver
    // decodes \\u2028 / \\u2029 back to the original characters, so this
    // is lossless.
    const safe = data
      .replace(/\u2028/g, '\\u2028')
      .replace(/\u2029/g, '\\u2029');
    proc.child.stdin.write(safe + '\n');
  }

  async restart(
    name: string,
    opts?: { onBeforeRespawn?: () => void },
  ): Promise<void> {
    const proc = this.processes.get(name);
    if (!proc) {
      return;
    }

    log.info(`Restarting "${name}"...`);
    if (proc.child && proc.child.exitCode === null) {
      proc.stopped = true;
      await this.killChild(proc.child, name);
    }
    opts?.onBeforeRespawn?.();
    proc.stopped = false;
    this.spawn(proc);
  }

  async stop(name: string): Promise<void> {
    const proc = this.processes.get(name);
    if (!proc) {
      log.debug(`stop("${name}"): not found`);
      return;
    }

    log.info(`Stopping "${name}"...`);
    proc.stopped = true;
    if (proc.restartTimer) {
      clearTimeout(proc.restartTimer);
    }

    if (!proc.child || proc.child.exitCode !== null) {
      this.registry.setState(name, 'stopped');
      log.debug(`"${name}" already exited`);
      return;
    }

    await this.killChild(proc.child, name);
    this.registry.setState(name, 'stopped');
    log.info(`"${name}" stopped`);
  }

  async stopAll(): Promise<void> {
    const names = Array.from(this.processes.keys());
    log.info(`Stopping all processes: ${names.join(', ')}`);
    const stops = names.map((name) => this.stop(name));
    await Promise.all(stops);
    log.info('All processes stopped');
  }

  private killChild(child: ChildProcess, name: string): Promise<void> {
    return new Promise((resolve) => {
      if (child.exitCode !== null) {
        resolve();
        return;
      }

      log.debug(`Sending SIGTERM to "${name}" (PID ${child.pid})`);
      const forceKill = setTimeout(() => {
        log.warn(`"${name}" did not exit in 5s, sending SIGKILL`);
        child.kill('SIGKILL');
      }, 5000);

      child.on('exit', () => {
        clearTimeout(forceKill);
        resolve();
      });

      child.kill('SIGTERM');
    });
  }
}
