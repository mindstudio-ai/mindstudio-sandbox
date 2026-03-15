import { spawn } from 'node:child_process';
import { resolveSafe, generateId } from '../../utils/paths.js';
import type { ProcessRegistry } from '../../processes/process-registry.js';

let workspaceDir: string;
let registry: ProcessRegistry | null = null;

export function initShell(dir: string, reg: ProcessRegistry): void {
  workspaceDir = dir;
  registry = reg;
}

function pipeOutput(
  stream: NodeJS.ReadableStream | null,
  streamName: 'stdout' | 'stderr',
  accum: { value: string },
  procName: string,
): void {
  stream?.on('data', (chunk: Buffer) => {
    const text = chunk.toString();
    accum.value += text;
    for (const line of text.split('\n')) {
      if (line) {
        registry?.appendLog(procName, streamName, line);
      }
    }
  });
}

export async function shell(params: {
  command: string;
  cwd?: string;
  timeout?: number;
}): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const cwd = params.cwd ? resolveSafe(workspaceDir, params.cwd) : workspaceDir;

  const timeout = params.timeout ?? 30000;
  const shellId = generateId('shell');

  registry?.register(shellId, 'shell', params.command);

  return new Promise((resolve, reject) => {
    const child = spawn('sh', ['-c', params.command], {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    registry?.setState(shellId, 'running', { pid: child.pid ?? null });

    let killed = false;
    const stdout = { value: '' };
    const stderr = { value: '' };

    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
    }, timeout);

    pipeOutput(child.stdout, 'stdout', stdout, shellId);
    pipeOutput(child.stderr, 'stderr', stderr, shellId);

    child.on('close', (code) => {
      clearTimeout(timer);
      if (killed) {
        registry?.setState(shellId, 'crashed', { exitCode: null });
        reject(new Error(`Command timed out after ${timeout}ms`));
      } else {
        registry?.setState(shellId, code === 0 ? 'completed' : 'crashed', {
          exitCode: code,
        });
        resolve({ exitCode: code, stdout: stdout.value, stderr: stderr.value });
      }
      // Clean up shell entries after 5 minutes
      const cleanup = setTimeout(() => registry?.remove(shellId), 5 * 60_000);
      cleanup.unref();
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      registry?.setState(shellId, 'crashed');
      reject(err);
    });
  });
}
