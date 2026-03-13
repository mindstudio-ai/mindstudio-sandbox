import { spawn } from 'node:child_process';
import path from 'node:path';
import type { SearchResult } from '../types.js';

let workspaceDir: string;

export function initSearch(dir: string): void {
  workspaceDir = dir;
}

export async function search(params: {
  query: string;
  path?: string;
  glob?: string;
  caseSensitive?: boolean;
  maxResults?: number;
}): Promise<{ results: SearchResult[] }> {
  const searchDir = params.path
    ? path.resolve(workspaceDir, params.path)
    : workspaceDir;

  // Validate no escape
  if (!searchDir.startsWith(workspaceDir)) {
    throw new Error('Path escapes workspace');
  }

  const maxResults = params.maxResults ?? 100;
  const results: SearchResult[] = [];

  return new Promise((resolve, reject) => {
    // Try ripgrep first, fall back to grep
    const useRg = true; // Could detect availability
    const args: string[] = [];

    if (useRg) {
      args.push('--json', '--no-heading');
      if (!params.caseSensitive) args.push('-i');
      if (params.glob) args.push('--glob', params.glob);
      args.push(
        '--glob', '!node_modules',
        '--glob', '!.git',
        '--glob', '!.vite',
        '--max-count', String(maxResults),
        params.query,
        searchDir,
      );
    }

    const child = spawn('rg', args, {
      cwd: workspaceDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';

    child.stdout?.on('data', (chunk: Buffer) => {
      const lines = chunk.toString().split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.type === 'match' && results.length < maxResults) {
            const data = parsed.data;
            results.push({
              file: path.relative(workspaceDir, data.path.text),
              line: data.line_number,
              column: data.submatches?.[0]?.start ?? 0,
              text: data.lines.text.replace(/\n$/, ''),
            });
          }
        } catch {
          // Non-JSON line, skip
        }
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('close', (code) => {
      // rg exits 1 when no matches found — that's fine
      if (code !== null && code > 1) {
        // Fall back to grep if rg not found
        if (stderr.includes('not found') || stderr.includes('No such file')) {
          grepFallback(params, searchDir, maxResults)
            .then(resolve)
            .catch(reject);
          return;
        }
      }
      resolve({ results });
    });

    child.on('error', () => {
      // rg not available, fall back to grep
      grepFallback(params, searchDir, maxResults).then(resolve).catch(reject);
    });
  });
}

function grepFallback(
  params: { query: string; caseSensitive?: boolean },
  searchDir: string,
  maxResults: number,
): Promise<{ results: SearchResult[] }> {
  return new Promise((resolve) => {
    const args = [
      '-rn',
      '--exclude-dir=node_modules',
      '--exclude-dir=.git',
      '--exclude-dir=.vite',
    ];
    if (!params.caseSensitive) args.push('-i');
    args.push(params.query, searchDir);

    const child = spawn('grep', args, {
      cwd: workspaceDir,
      stdio: ['ignore', 'pipe', 'ignore'],
    });

    const results: SearchResult[] = [];
    let buf = '';

    child.stdout?.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop() || '';

      for (const line of lines) {
        if (results.length >= maxResults) break;
        // Format: file:line:text
        const match = line.match(/^(.+?):(\d+):(.*)$/);
        if (match) {
          results.push({
            file: path.relative(workspaceDir, match[1]),
            line: parseInt(match[2], 10),
            column: 0,
            text: match[3],
          });
        }
      }
    });

    child.on('close', () => {
      resolve({ results });
    });
  });
}
