import { spawn } from 'node:child_process';
import path from 'node:path';

let workspaceDir: string;
let broadcast: (event: string, data: Record<string, unknown>) => void;

export function initShell(
  dir: string,
  broadcastFn: (event: string, data: Record<string, unknown>) => void,
): void {
  workspaceDir = dir;
  broadcast = broadcastFn;
}

export async function shell(params: {
  command: string;
  cwd?: string;
  timeout?: number;
}): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const cwd = params.cwd
    ? path.resolve(workspaceDir, params.cwd)
    : workspaceDir;

  // Validate no escape
  if (!cwd.startsWith(workspaceDir)) {
    throw new Error('Path escapes workspace');
  }

  const timeout = params.timeout ?? 30000;

  return new Promise((resolve, reject) => {
    const child = spawn('sh', ['-c', params.command], {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
    }, timeout);

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      // Stream each line to connected clients
      for (const line of text.split('\n')) {
        if (line) {
          broadcast('processOutput', {
            process: 'shell',
            stream: 'stdout',
            line,
          });
        }
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      for (const line of text.split('\n')) {
        if (line) {
          broadcast('processOutput', {
            process: 'shell',
            stream: 'stderr',
            line,
          });
        }
      }
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (killed) {
        reject(new Error(`Command timed out after ${timeout}ms`));
      } else {
        resolve({ exitCode: code, stdout, stderr });
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
