/**
 * Workspace search — streaming ripgrep results over WebSocket.
 *
 * Spawns `rg --json` per request, parses NDJSON output, batches matches
 * per file, and broadcasts `searchResult` events keyed by `searchId`.
 * On rg exit (natural, capped, cancelled, or timed-out) emits
 * `searchCompleted`.
 *
 * Cancellation is required because the FE fires one search per
 * keystroke — kill the prior child before starting the next.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { attachLineHandler } from '../../processes/lineSplitter.js';
import { generateId } from '../../utils/paths.js';
import { broadcast } from '../index.js';
import { createLogger } from '../../logger.js';

const log = createLogger('search');

const SEARCH_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_MATCHES = 5000;
const DEFAULT_MAX_FILES = 500;
const RG_MAX_FILESIZE = '10M';

// Excluded on top of rg's own gitignore handling. Cover sandbox runtime
// state that isn't always in the project .gitignore plus the universal
// "never search this" set.
const DEFAULT_EXCLUDES = [
  'node_modules/**',
  '.git/**',
  '.logs/**',
  '.remy-*',
  '.sandbox-state.json',
  '.project-status.json',
];

let workspaceDir: string = '';

export function initSearch(dir: string): void {
  workspaceDir = dir;
}

interface SearchParams {
  query: string;
  isRegex?: boolean;
  caseSensitive?: boolean;
  wholeWord?: boolean;
  multiline?: boolean;
  includes?: string[];
  excludes?: string[];
  maxMatches?: number;
  maxFiles?: number;
}

interface SubMatch {
  start: number;
  end: number;
}

interface Hit {
  line: number;
  column: number;
  endColumn: number;
  text: string;
  subMatches: SubMatch[];
}

interface ActiveSearch {
  child: ChildProcess;
  killer: NodeJS.Timeout;
  cancelled: boolean;
}

const activeSearches = new Map<string, ActiveSearch>();

function buildArgs(p: SearchParams): string[] {
  const args = ['--json', `--max-filesize=${RG_MAX_FILESIZE}`];

  if (!p.caseSensitive) {
    args.push('-i');
  }
  if (p.wholeWord) {
    args.push('-w');
  }
  if (p.isRegex) {
    // rg defaults to its regex engine. -P would switch to PCRE2.
    // Stick with the default — it's faster and the FE will tell us if
    // they need PCRE features.
  } else {
    args.push('-F'); // fixed-string literal match
  }
  if (p.multiline) {
    args.push('-U', '--multiline-dotall');
  }

  for (const exc of DEFAULT_EXCLUDES) {
    args.push('--glob', `!${exc}`);
  }
  for (const inc of p.includes ?? []) {
    args.push('--glob', inc);
  }
  for (const exc of p.excludes ?? []) {
    args.push('--glob', `!${exc}`);
  }

  // Pattern terminator — '--' so a query starting with '-' isn't treated
  // as a flag.
  args.push('--', p.query);
  return args;
}

interface FileAccumulator {
  path: string;
  hits: Hit[];
}

/**
 * Parse one rg JSON line. rg emits `begin` / `match` / `end` / `summary`
 * objects. Hits within a file may stream across many lines before `end`;
 * we accumulate per file and flush on `end`.
 */
function parseLine(
  line: string,
): { type: string; data: Record<string, unknown> } | null {
  if (!line) {
    return null;
  }
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function extractText(field: unknown): string {
  if (field && typeof field === 'object' && 'text' in field) {
    return String((field as { text: unknown }).text);
  }
  return '';
}

export function searchWorkspace(rawParams: Record<string, unknown>): {
  searchId: string;
} {
  const p = rawParams as unknown as SearchParams;
  if (!p.query || typeof p.query !== 'string') {
    throw new Error('Missing or invalid "query" parameter');
  }

  const searchId = generateId('search');
  const maxMatches = p.maxMatches ?? DEFAULT_MAX_MATCHES;
  const maxFiles = p.maxFiles ?? DEFAULT_MAX_FILES;
  const args = buildArgs(p);

  log.info(`Starting search ${searchId}: query="${p.query}"`);
  const startTime = Date.now();

  const child = spawn('rg', args, {
    cwd: workspaceDir,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let totalMatches = 0;
  let totalFiles = 0;
  let truncated = false;
  let current: FileAccumulator | null = null;

  const killer = setTimeout(() => {
    log.warn(`Search ${searchId} hit ${SEARCH_TIMEOUT_MS}ms timeout, killing`);
    truncated = true;
    child.kill('SIGTERM');
  }, SEARCH_TIMEOUT_MS);
  killer.unref();

  activeSearches.set(searchId, { child, killer, cancelled: false });

  function flushCurrent(): void {
    if (!current || current.hits.length === 0) {
      current = null;
      return;
    }
    const filePath = current.path;
    const hits = current.hits;
    current = null;
    totalFiles++;

    // Stat for fileMeta. Best-effort — if it fails (deleted mid-search),
    // emit the hits anyway without meta.
    fs.stat(path.join(workspaceDir, filePath))
      .then((stat) => {
        broadcast('searchResult', {
          searchId,
          path: filePath,
          hits,
          fileMeta: { mtime: stat.mtimeMs, size: stat.size },
        });
      })
      .catch(() => {
        broadcast('searchResult', { searchId, path: filePath, hits });
      });
  }

  if (child.stdout) {
    attachLineHandler(child.stdout, (line) => {
      const msg = parseLine(line);
      if (!msg) {
        return;
      }
      const data = msg.data ?? {};
      switch (msg.type) {
        case 'begin': {
          flushCurrent();
          current = { path: extractText(data.path), hits: [] };
          break;
        }
        case 'match': {
          if (!current) {
            return;
          }
          const text = extractText(data.lines);
          const line = Number(data.line_number) || 0;
          const submatches = Array.isArray(data.submatches)
            ? (data.submatches as Array<Record<string, unknown>>)
            : [];
          const subMatches: SubMatch[] = submatches.map((s) => ({
            start: Number(s.start) || 0,
            end: Number(s.end) || 0,
          }));
          const first = subMatches[0] ?? { start: 0, end: 0 };
          current.hits.push({
            line,
            column: first.start + 1,
            endColumn: first.end + 1,
            text: text.replace(/\n$/, ''),
            subMatches,
          });
          totalMatches++;

          if (totalMatches >= maxMatches) {
            truncated = true;
            log.info(
              `Search ${searchId} hit maxMatches=${maxMatches}, killing rg`,
            );
            child.kill('SIGTERM');
          }
          break;
        }
        case 'end': {
          flushCurrent();
          if (totalFiles >= maxFiles) {
            truncated = true;
            log.info(`Search ${searchId} hit maxFiles=${maxFiles}, killing rg`);
            child.kill('SIGTERM');
          }
          break;
        }
      }
    });
  }

  if (child.stderr) {
    attachLineHandler(child.stderr, (line) => {
      if (line.trim()) {
        log.warn(`rg stderr [${searchId}]: ${line}`);
      }
    });
  }

  child.on('error', (err) => {
    log.error(`Search ${searchId} spawn error: ${err.message}`);
  });

  child.on('exit', (code, signal) => {
    flushCurrent();
    clearTimeout(killer);
    const entry = activeSearches.get(searchId);
    const cancelled = entry?.cancelled === true;
    activeSearches.delete(searchId);

    const elapsedMs = Date.now() - startTime;
    log.info(
      `Search ${searchId} exited (code=${code}, signal=${signal}, matches=${totalMatches}, files=${totalFiles}, elapsed=${elapsedMs}ms, cancelled=${cancelled}, truncated=${truncated})`,
    );

    broadcast('searchCompleted', {
      searchId,
      totalMatches,
      totalFiles,
      truncated,
      cancelled,
      elapsedMs,
    });
  });

  return { searchId };
}

export function cancelSearch(rawParams: Record<string, unknown>): {
  cancelled: boolean;
} {
  const { searchId } = rawParams as { searchId?: string };
  if (!searchId) {
    throw new Error('Missing "searchId" parameter');
  }
  const entry = activeSearches.get(searchId);
  if (!entry) {
    return { cancelled: false };
  }
  entry.cancelled = true;
  entry.child.kill('SIGTERM');
  return { cancelled: true };
}

/**
 * Startup probe: confirm `rg` is on PATH. Resolves false if not — the
 * caller can log a loud error so search-not-working is obvious at boot,
 * not on first user query.
 */
export function probeRipgrep(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('rg', ['--version'], { stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('exit', (code) => resolve(code === 0));
  });
}
