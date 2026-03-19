import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import type {
  ProcessRegistry,
  ProcessState,
  ProcessInfo,
  ProcessLogEntry,
} from './ProcessRegistry.js';

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
  onStdout?: (line: string) => void;
  onStderr?: (line: string) => void;
}
import { createLogger } from '../logger.js';

const log = createLogger('process-manager');

interface ManagedProcess {
  config: ManagedProcessConfig;
  child: ChildProcess | null;
  restartTimer: ReturnType<typeof setTimeout> | null;
  stopped: boolean;
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

    const rls: Array<ReturnType<typeof createInterface>> = [];

    if (child.stdout) {
      const rl = createInterface({ input: child.stdout });
      rl.on('line', (line) => {
        // Truncate very long lines in the process log (e.g., agent history
        // responses) — full content is handled by onStdout, the log is just
        // for debugging visibility.
        const logLine =
          line.length > 2000 ? line.slice(0, 2000) + '… (truncated)' : line;
        this.registry.appendLog(config.name, 'stdout', logLine);
        config.onStdout?.(line);
      });
      rls.push(rl);
    }

    if (child.stderr) {
      const rl = createInterface({ input: child.stderr });
      rl.on('line', (line) => {
        this.registry.appendLog(config.name, 'stderr', line);
        config.onStderr?.(line);
      });
      rls.push(rl);
    }

    child.on('exit', (code, signal) => {
      for (const rl of rls) {
        rl.close();
      }
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

  getState(name: string): ProcessState | undefined {
    return this.registry.getInfo(name)?.state;
  }

  getProcesses(): ProcessInfo[] {
    return this.registry.getAllInfo();
  }

  getProcessLog(name: string): ProcessLogEntry[] {
    return this.registry.getLog(name);
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
    proc.child.stdin.write(data + '\n');
  }

  async restart(name: string): Promise<void> {
    const proc = this.processes.get(name);
    if (!proc) {
      return;
    }

    log.info(`Restarting "${name}"...`);
    if (proc.child && proc.child.exitCode === null) {
      proc.stopped = true;
      await this.killChild(proc.child, name);
    }
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
