/**
 * Shell execution helpers for bootstrap tasks.
 *
 * Wraps execSync/exec with logging and process registry tracking.
 * Extracted so other modules can import these without pulling in all
 * of bootstrap.
 */

import { exec, execSync, type ExecSyncOptions } from 'node:child_process';
import type { ProcessRegistry } from '../processes/ProcessRegistry.js';
import { createLogger } from '../logger.js';

const log = createLogger('bootstrap');

let registry: ProcessRegistry | null = null;

export function setRegistry(r: ProcessRegistry): void {
  registry = r;
}

function procName(label: string): string {
  return `bootstrap:${label.replace(/\s+/g, '-').slice(0, 60)}`;
}

/** Run a command synchronously with logging and registry tracking. */
export function run(
  cmd: string,
  opts?: ExecSyncOptions & { label?: string },
): string {
  const label = opts?.label ?? cmd;
  const name = procName(label);

  registry?.register(name, 'task', cmd);
  registry?.setState(name, 'running');

  log.info(`Running: ${label}`);
  const startTime = Date.now();
  try {
    const result = execSync(cmd, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 300_000,
      ...opts,
    }) as string;
    const elapsed = Date.now() - startTime;
    log.info(`Completed in ${elapsed}ms: ${label}`);
    if (result.trim()) {
      for (const line of result.trim().split('\n')) {
        registry?.appendLog(name, line);
      }
    }
    registry?.setState(name, 'completed', { exitCode: 0 });
    return result;
  } catch (err: unknown) {
    const elapsed = Date.now() - startTime;
    const execErr = err as {
      stderr?: string;
      stdout?: string;
      status?: number;
    };
    log.error(`FAILED after ${elapsed}ms: ${label}`);
    log.error(`  Exit code: ${execErr.status}`);
    if (execErr.stderr) {
      for (const line of execErr.stderr.trim().split('\n')) {
        registry?.appendLog(name, line, { level: 'error' });
      }
    }
    if (execErr.stdout) {
      for (const line of execErr.stdout.trim().split('\n')) {
        registry?.appendLog(name, line);
      }
    }
    registry?.setState(name, 'crashed', { exitCode: execErr.status ?? 1 });
    throw err;
  }
}

/** Run a command asynchronously with logging and registry tracking. */
export function runAsync(
  cmd: string,
  opts?: { cwd?: string; label?: string },
): Promise<string> {
  const label = opts?.label ?? cmd;
  const name = procName(label);

  registry?.register(name, 'task', cmd);
  registry?.setState(name, 'running');

  log.info(`Running: ${label}`);
  const startTime = Date.now();

  return new Promise((resolve, reject) => {
    exec(
      cmd,
      {
        encoding: 'utf-8',
        timeout: 300_000,
        ...(opts?.cwd ? { cwd: opts.cwd } : {}),
      },
      (err, stdout, stderr) => {
        const elapsed = Date.now() - startTime;
        if (err) {
          log.error(`FAILED after ${elapsed}ms: ${label}`);
          if (stderr?.trim()) {
            for (const line of stderr.trim().split('\n')) {
              registry?.appendLog(name, line, { level: 'error' });
            }
          }
          registry?.setState(name, 'crashed', {
            exitCode: (err as { code?: number }).code ?? 1,
          });
          reject(err);
          return;
        }
        log.info(`Completed in ${elapsed}ms: ${label}`);
        if (stdout?.trim()) {
          for (const line of stdout.trim().split('\n')) {
            registry?.appendLog(name, line);
          }
        }
        registry?.setState(name, 'completed', { exitCode: 0 });
        resolve(stdout ?? '');
      },
    );
  });
}

/** Check if a binary is on PATH. */
export function isInstalled(binaryName: string): boolean {
  try {
    execSync(`which ${binaryName}`, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Major version of the `tsc` on PATH (i.e. the global TypeScript), or null if
 * `tsc` is absent or its output can't be parsed. `tsc --version` prints
 * `"Version 6.0.3"`. Best-effort, mirrors `isInstalled` — used to detect a
 * stray global TypeScript that floated off the pinned classic line.
 */
export function globalTscMajor(): number | null {
  try {
    const out = execSync('tsc --version', {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const match = out.match(/Version (\d+)\./);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

/** Log the install location of a binary, or warn if missing. */
export function verifyInstalled(binaryName: string): void {
  if (isInstalled(binaryName)) {
    log.info(
      `${binaryName} installed at: ${execSync(`which ${binaryName}`, { encoding: 'utf-8' }).trim()}`,
    );
  } else {
    log.warn(`${binaryName} not found after install`);
  }
}

/**
 * Clone a git repo, build from source, and npm install -g the result.
 * Used for dev branches where the published npm package won't work.
 */
export function installFromSource(opts: {
  repoUrl: string;
  branch: string;
  tmpDir: string;
  label: string;
}): void {
  run(`rm -rf ${opts.tmpDir}`, { label: `Clean ${opts.label} dir` });
  run(
    `git clone --depth 1 --branch ${opts.branch} ${opts.repoUrl} ${opts.tmpDir}`,
    { label: `git clone ${opts.label} (${opts.branch})` },
  );
  run('npm install', {
    cwd: opts.tmpDir,
    label: `npm install in ${opts.label}`,
  });
  run('npm run build', {
    cwd: opts.tmpDir,
    label: `npm run build in ${opts.label}`,
  });
  run(`npm install -g ${opts.tmpDir}`, {
    label: `npm install -g (link built ${opts.label})`,
  });
}
