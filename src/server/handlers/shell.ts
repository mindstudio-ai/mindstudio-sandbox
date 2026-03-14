import { spawn } from 'node:child_process';
import { resolveSafe } from '../../utils/paths.js';

let workspaceDir: string;
let broadcast: (event: string, data: Record<string, unknown>) => void;

export function initShell(
  dir: string,
  broadcastFn: (event: string, data: Record<string, unknown>) => void,
): void {
  workspaceDir = dir;
  broadcast = broadcastFn;
}

function pipeOutput(
  stream: NodeJS.ReadableStream | null,
  name: 'stdout' | 'stderr',
  accum: { value: string },
): void {
  stream?.on('data', (chunk: Buffer) => {
    const text = chunk.toString();
    accum.value += text;
    for (const line of text.split('\n')) {
      if (line) {
        broadcast('processOutput', { process: 'shell', stream: name, line });
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

  return new Promise((resolve, reject) => {
    const child = spawn('sh', ['-c', params.command], {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let killed = false;
    const stdout = { value: '' };
    const stderr = { value: '' };

    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
    }, timeout);

    pipeOutput(child.stdout, 'stdout', stdout);
    pipeOutput(child.stderr, 'stderr', stderr);

    child.on('close', (code) => {
      clearTimeout(timer);
      if (killed) {
        reject(new Error(`Command timed out after ${timeout}ms`));
      } else {
        resolve({ exitCode: code, stdout: stdout.value, stderr: stderr.value });
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
