import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { ManagedProcessConfig, ProcessState } from './types.js';

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

    console.log(
      `[process-manager] Registering process "${config.name}": ${config.command} ${config.args.join(' ')}`,
    );
    console.log(`[process-manager]   cwd: ${config.cwd}`);
    console.log(
      `[process-manager]   restartOnCrash: ${config.restartOnCrash}, maxRestarts: ${config.maxRestarts}`,
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
      console.log(
        `[process-manager] "${proc.config.name}" is stopped, not spawning`,
      );
      return;
    }

    proc.state = 'starting';
    const { config } = proc;

    console.log(
      `[process-manager] Spawning "${config.name}": ${config.command} ${config.args.join(' ')}`,
    );

    let child: ChildProcess;
    try {
      child = spawn(config.command, config.args, {
        cwd: config.cwd,
        env: { ...process.env, ...config.env },
        stdio: [config.stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      console.error(
        `[process-manager] Failed to spawn "${config.name}": ${err instanceof Error ? err.message : err}`,
      );
      proc.state = 'crashed';
      return;
    }

    proc.child = child;
    proc.state = 'running';
    console.log(
      `[process-manager] "${config.name}" spawned with PID ${child.pid}`,
    );

    if (child.stdout) {
      const rl = createInterface({ input: child.stdout });
      rl.on('line', (line) => config.onStdout?.(line));
    }

    if (child.stderr) {
      const rl = createInterface({ input: child.stderr });
      rl.on('line', (line) => {
        console.log(`[${config.name}:stderr] ${line}`);
        config.onStderr?.(line);
      });
    }

    child.on('exit', (code, signal) => {
      console.log(
        `[process-manager] "${config.name}" (PID ${child.pid}) exited — code=${code}, signal=${signal}`,
      );

      if (proc.stopped) {
        proc.state = 'stopped';
        console.log(
          `[process-manager] "${config.name}" was intentionally stopped`,
        );
        return;
      }

      proc.state = 'crashed';

      if (config.restartOnCrash && proc.restartCount < config.maxRestarts) {
        const delay = Math.min(1000 * 2 ** proc.restartCount, 30000);
        console.log(
          `[process-manager] Will restart "${config.name}" in ${delay}ms (attempt ${proc.restartCount + 1}/${config.maxRestarts})`,
        );
        proc.restartTimer = setTimeout(() => {
          proc.restartCount++;
          this.spawn(proc);
        }, delay);
      } else if (proc.restartCount >= config.maxRestarts) {
        console.error(
          `[process-manager] "${config.name}" exceeded max restarts (${config.maxRestarts}), giving up`,
        );
        if (config.critical) {
          console.error(
            `[process-manager] "${config.name}" is critical — exiting`,
          );
          process.exit(1);
        }
      }
    });

    child.on('error', (err) => {
      console.error(
        `[process-manager] "${config.name}" spawn error: ${err.message}`,
      );
      console.error(
        `[process-manager]   code: ${(err as NodeJS.ErrnoException).code}`,
      );
      console.error(
        `[process-manager]   path: ${(err as NodeJS.ErrnoException).path}`,
      );
    });
  }

  getState(name: string): ProcessState | undefined {
    return this.processes.get(name)?.state;
  }

  writeStdin(name: string, data: string): void {
    const proc = this.processes.get(name);
    if (!proc?.child?.stdin) {
      console.error(
        `[process-manager] writeStdin("${name}"): no stdin available`,
      );
      return;
    }
    if (proc.child.exitCode !== null) {
      console.error(
        `[process-manager] writeStdin("${name}"): process already exited`,
      );
      return;
    }
    proc.child.stdin.write(data + '\n');
  }

  async restart(name: string): Promise<void> {
    const proc = this.processes.get(name);
    if (!proc) {
      return;
    }

    console.log(`[process-manager] Restarting "${name}"...`);
    // Kill existing
    if (proc.child && proc.child.exitCode === null) {
      proc.stopped = true;
      await this.killChild(proc.child, name);
    }
    // Reset and respawn
    proc.stopped = false;
    proc.restartCount = 0;
    this.spawn(proc);
  }

  async stop(name: string): Promise<void> {
    const proc = this.processes.get(name);
    if (!proc) {
      console.log(`[process-manager] stop("${name}"): not found`);
      return;
    }

    console.log(`[process-manager] Stopping "${name}"...`);
    proc.stopped = true;
    if (proc.restartTimer) {
      clearTimeout(proc.restartTimer);
    }

    if (!proc.child || proc.child.exitCode !== null) {
      proc.state = 'stopped';
      console.log(`[process-manager] "${name}" already exited`);
      return;
    }

    await this.killChild(proc.child, name);
    proc.state = 'stopped';
    console.log(`[process-manager] "${name}" stopped`);
  }

  async stopAll(): Promise<void> {
    const names = Array.from(this.processes.keys());
    console.log(
      `[process-manager] Stopping all processes: ${names.join(', ')}`,
    );
    const stops = names.map((name) => this.stop(name));
    await Promise.all(stops);
    console.log('[process-manager] All processes stopped');
  }

  private killChild(child: ChildProcess, name: string): Promise<void> {
    return new Promise((resolve) => {
      if (child.exitCode !== null) {
        resolve();
        return;
      }

      console.log(
        `[process-manager] Sending SIGTERM to "${name}" (PID ${child.pid})`,
      );
      const forceKill = setTimeout(() => {
        console.log(
          `[process-manager] "${name}" did not exit in 5s, sending SIGKILL`,
        );
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
