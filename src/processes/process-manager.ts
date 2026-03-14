import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { ManagedProcessConfig, ProcessState } from '../types.js';
import { createLogger } from '../logger.js';

const log = createLogger('process-manager');

interface ManagedProcess {
  config: ManagedProcessConfig;
  child: ChildProcess | null;
  state: ProcessState;
  restartCount: number;
  restartTimer: ReturnType<typeof setTimeout> | null;
  stopped: boolean;
}

export class ProcessManager {
  private processes = new Map<string, ManagedProcess>();

  start(config: ManagedProcessConfig): void {
    if (this.processes.has(config.name)) {
      throw new Error(`Process "${config.name}" already registered`);
    }

    log.info(
      `Registering "${config.name}": ${config.command} ${config.args.join(' ')}`,
    );
    log.debug(`  "${config.name}" cwd: ${config.cwd}`);
    log.debug(
      `  "${config.name}" restartOnCrash: ${config.restartOnCrash}, maxRestarts: ${config.maxRestarts}`,
    );

    const proc: ManagedProcess = {
      config,
      child: null,
      state: 'starting',
      restartCount: 0,
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

    proc.state = 'starting';
    const { config } = proc;

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
      proc.state = 'crashed';
      return;
    }

    proc.child = child;
    proc.state = 'running';
    log.info(`"${config.name}" spawned with PID ${child.pid}`);

    if (child.stdout) {
      const rl = createInterface({ input: child.stdout });
      rl.on('line', (line) => config.onStdout?.(line));
    }

    if (child.stderr) {
      const rl = createInterface({ input: child.stderr });
      rl.on('line', (line) => config.onStderr?.(line));
    }

    child.on('exit', (code, signal) => {
      log.info(
        `"${config.name}" (PID ${child.pid}) exited — code=${code}, signal=${signal}`,
      );

      if (proc.stopped) {
        proc.state = 'stopped';
        log.debug(`"${config.name}" was intentionally stopped`);
        return;
      }

      proc.state = 'crashed';

      if (config.restartOnCrash && proc.restartCount < config.maxRestarts) {
        const delay = Math.min(1000 * 2 ** proc.restartCount, 30000);
        log.info(
          `Will restart "${config.name}" in ${delay}ms (attempt ${proc.restartCount + 1}/${config.maxRestarts})`,
        );
        proc.restartTimer = setTimeout(() => {
          proc.restartCount++;
          this.spawn(proc);
        }, delay);
      } else if (proc.restartCount >= config.maxRestarts) {
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
    return this.processes.get(name)?.state;
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
    proc.restartCount = 0;
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
      proc.state = 'stopped';
      log.debug(`"${name}" already exited`);
      return;
    }

    await this.killChild(proc.child, name);
    proc.state = 'stopped';
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
