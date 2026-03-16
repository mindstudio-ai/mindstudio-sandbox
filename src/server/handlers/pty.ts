/**
 * PTY handler — interactive terminal sessions with full emulation.
 *
 * Spawns pseudo-terminals via node-pty. Output (including ANSI codes)
 * is streamed to WebSocket clients as batched `ptyOutput` events.
 * Clients send keystrokes via `ptyWrite`. Frontend renders with xterm.js.
 */

import * as pty from 'node-pty';
import type { ProcessRegistry } from '../../processes/ProcessRegistry.js';
import type { BroadcastBatcher } from '../server/BroadcastBatcher.js';
import { generateId } from '../../utils/paths.js';
import { createLogger } from '../../logger.js';

const log = createLogger('pty');

const MAX_SCROLLBACK = 50 * 1024; // 50KB per session
const CLEANUP_DELAY_MS = 5 * 60_000; // 5 minutes after close

interface PtySession {
  pty: pty.IPty;
  sessionId: string;
  scrollback: string;
}

let registry: ProcessRegistry | null = null;
let batcher: BroadcastBatcher | null = null;
let workspaceDir: string = '/workspace';
const sessions = new Map<string, PtySession>();

export function initPty(
  dir: string,
  reg: ProcessRegistry,
  bat: BroadcastBatcher,
): void {
  workspaceDir = dir;
  registry = reg;
  batcher = bat;
}

export async function ptyCreate(params: {
  cols?: number;
  rows?: number;
  cwd?: string;
}): Promise<{ sessionId: string }> {
  const sessionId = generateId('pty');
  const cols = params.cols ?? 80;
  const rows = params.rows ?? 24;
  const cwd = params.cwd ?? workspaceDir;
  const shell = process.env.SHELL || 'sh';

  log.info(`Creating PTY session ${sessionId} (${cols}x${rows}, cwd: ${cwd})`);

  const term = pty.spawn(shell, [], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env: process.env as Record<string, string>,
  });

  const session: PtySession = {
    pty: term,
    sessionId,
    scrollback: '',
  };
  sessions.set(sessionId, session);

  // Register in process registry for dashboard visibility
  registry?.register(sessionId, 'pty', shell);
  registry?.setState(sessionId, 'running', { pid: term.pid });

  // Stream output to clients via batcher
  term.onData((data) => {
    // Append to scrollback (for reconnect)
    session.scrollback += data;
    if (session.scrollback.length > MAX_SCROLLBACK) {
      session.scrollback = session.scrollback.slice(-MAX_SCROLLBACK);
    }

    // Broadcast raw terminal data
    batcher?.push('ptyOutput', { sessionId, data });
  });

  term.onExit(({ exitCode, signal }) => {
    log.info(
      `PTY session ${sessionId} exited (code=${exitCode}, signal=${signal})`,
    );
    registry?.setState(sessionId, exitCode === 0 ? 'completed' : 'stopped', {
      exitCode,
      signal: signal !== undefined ? String(signal) : undefined,
    });

    // Clean up after delay
    const cleanup = setTimeout(() => {
      sessions.delete(sessionId);
      registry?.remove(sessionId);
    }, CLEANUP_DELAY_MS);
    cleanup.unref();
  });

  return { sessionId };
}

export async function ptyWrite(params: {
  sessionId: string;
  data: string;
}): Promise<Record<string, never>> {
  const session = sessions.get(params.sessionId);
  if (!session) {
    throw new Error(`PTY session not found: ${params.sessionId}`);
  }
  session.pty.write(params.data);
  return {};
}

export async function ptyResize(params: {
  sessionId: string;
  cols: number;
  rows: number;
}): Promise<Record<string, never>> {
  const session = sessions.get(params.sessionId);
  if (!session) {
    throw new Error(`PTY session not found: ${params.sessionId}`);
  }
  session.pty.resize(params.cols, params.rows);
  return {};
}

export async function ptyClose(params: {
  sessionId: string;
}): Promise<Record<string, never>> {
  const session = sessions.get(params.sessionId);
  if (!session) {
    throw new Error(`PTY session not found: ${params.sessionId}`);
  }
  log.info(`Closing PTY session ${params.sessionId}`);
  session.pty.kill();
  return {};
}

export async function ptyGetScrollback(params: {
  sessionId: string;
}): Promise<{ data: string }> {
  const session = sessions.get(params.sessionId);
  if (!session) {
    throw new Error(`PTY session not found: ${params.sessionId}`);
  }
  return { data: session.scrollback };
}

/** Get all active session IDs (for init frame). */
export function getActiveSessionIds(): string[] {
  return Array.from(sessions.keys());
}

/** Close all PTY sessions (for shutdown). */
export function closeAllPty(): void {
  for (const [id, session] of sessions) {
    log.info(`Closing PTY session ${id} (shutdown)`);
    session.pty.kill();
  }
  sessions.clear();
}
