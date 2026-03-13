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
    if (proc.stopped) return;

    proc.state = 'starting';
    const { config } = proc;

    const child = spawn(config.command, config.args, {
      cwd: config.cwd,
      env: { ...process.env, ...config.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    proc.child = child;
    proc.state = 'running';

    if (child.stdout) {
      const rl = createInterface({ input: child.stdout });
      rl.on('line', (line) => config.onStdout?.(line));
    }

    if (child.stderr) {
      const rl = createInterface({ input: child.stderr });
      rl.on('line', (line) => config.onStderr?.(line));
    }

    child.on('exit', (code, signal) => {
      if (proc.stopped) {
        proc.state = 'stopped';
        return;
      }

      proc.state = 'crashed';
      console.error(
        `[process-manager] "${config.name}" exited (code=${code}, signal=${signal})`,
      );

      if (config.restartOnCrash && proc.restartCount < config.maxRestarts) {
        const delay = Math.min(1000 * 2 ** proc.restartCount, 30000);
        console.log(
          `[process-manager] Restarting "${config.name}" in ${delay}ms (attempt ${proc.restartCount + 1}/${config.maxRestarts})`,
        );
        proc.restartTimer = setTimeout(() => {
          proc.restartCount++;
          this.spawn(proc);
        }, delay);
      }
    });

    child.on('error', (err) => {
      console.error(
        `[process-manager] "${config.name}" spawn error: ${err.message}`,
      );
    });
  }

  getState(name: string): ProcessState | undefined {
    return this.processes.get(name)?.state;
  }

  async stop(name: string): Promise<void> {
    const proc = this.processes.get(name);
    if (!proc) return;

    proc.stopped = true;
    if (proc.restartTimer) {
      clearTimeout(proc.restartTimer);
    }

    if (!proc.child || proc.child.exitCode !== null) {
      proc.state = 'stopped';
      return;
    }

    await this.killChild(proc.child);
    proc.state = 'stopped';
  }

  async stopAll(): Promise<void> {
    const stops = Array.from(this.processes.keys()).map((name) =>
      this.stop(name),
    );
    await Promise.all(stops);
  }

  private killChild(child: ChildProcess): Promise<void> {
    return new Promise((resolve) => {
      if (child.exitCode !== null) {
        resolve();
        return;
      }

      const forceKill = setTimeout(() => {
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
