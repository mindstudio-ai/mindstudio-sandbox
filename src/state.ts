/**
 * Persistent sandbox state — survives hibernate/resume via filesystem snapshot.
 *
 * Stores the process output log. Chat history is owned by remy
 * (persisted in .remy-session.json, fetched via get_history action).
 *
 * Auto-save: state is flushed synchronously (writeFileSync) after
 * output accumulates, debounced to avoid thrashing. This survives
 * unclean shutdowns where SIGTERM never arrives.
 */

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { createLogger } from './logger.js';

const log = createLogger('state');

// --- Types ---

export interface OutputLine {
  process: string;
  stream: 'stdout' | 'stderr';
  line: string;
  ts: number;
}

interface SandboxState {
  outputLog: OutputLine[];
}

// --- In-memory state ---

const MAX_OUTPUT_LINES = 5000;
const FLUSH_DEBOUNCE_MS = 5_000; // 5 seconds after last mutation

const state: SandboxState = {
  outputLog: [],
};

let statePath: string = '/tmp/sandbox-state.json';
let dirty = false;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

// --- Auto-save ---

/** Mark state as dirty and schedule a synchronous flush. */
function markDirty(): void {
  dirty = true;
  if (flushTimer) {
    return; // already scheduled
  }
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushSync();
  }, FLUSH_DEBOUNCE_MS);
  flushTimer.unref();
}

/** Synchronous write — survives even if the process is about to die. */
function flushSync(): void {
  if (!dirty) {
    return;
  }
  try {
    const json = JSON.stringify(state);
    fsSync.writeFileSync(statePath, json, 'utf-8');
    dirty = false;
    log.debug(`Auto-saved (${state.outputLog.length} output lines)`);
  } catch (err) {
    log.error(`Auto-save failed: ${err instanceof Error ? err.message : err}`);
  }
}

export function stopAutoSave(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
}

// --- Init ---

export function initState(workspaceDir: string): void {
  statePath = path.join(workspaceDir, '.sandbox-state.json');
}

// --- Process output log ---

export function getOutputLog(): OutputLine[] {
  return state.outputLog;
}

export function appendOutput(
  process: string,
  stream: 'stdout' | 'stderr',
  line: string,
): void {
  state.outputLog.push({ process, stream, line, ts: Date.now() });
  // Ring buffer — drop oldest lines when full
  if (state.outputLog.length > MAX_OUTPUT_LINES) {
    state.outputLog.splice(0, state.outputLog.length - MAX_OUTPUT_LINES);
  }
  markDirty();
}

// --- Save / Restore ---

export async function saveState(): Promise<void> {
  try {
    stopAutoSave();
    const json = JSON.stringify(state, null, 2);
    await fs.writeFile(statePath, json, 'utf-8');
    dirty = false;
    log.info(`Saved (${state.outputLog.length} output lines) → ${statePath}`);
  } catch (err) {
    log.error(`Failed to save: ${err instanceof Error ? err.message : err}`);
  }
}

export async function restoreState(): Promise<boolean> {
  try {
    const json = await fs.readFile(statePath, 'utf-8');
    const saved = JSON.parse(json) as SandboxState;
    if (saved.outputLog) {
      state.outputLog.push(...saved.outputLog);
    }
    log.info(
      `Restored (${state.outputLog.length} output lines) ← ${statePath}`,
    );
    return true;
  } catch {
    log.info(`No saved state found at ${statePath}`);
    return false;
  }
}
