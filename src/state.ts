/**
 * Persistent sandbox state — survives hibernate/resume via filesystem snapshot.
 *
 * Stores process registry snapshots (metadata + per-process logs).
 * Chat history is owned by remy (fetched via get_history action).
 *
 * Auto-save: state is flushed synchronously (writeFileSync) after
 * mutations, debounced to avoid thrashing. This survives unclean
 * shutdowns where SIGTERM never arrives.
 */

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import type { ProcessSnapshot, EditorState } from './types.js';
import type { ProcessRegistry } from './processes/process-registry.js';
import type { EditorStateManager } from './server/editor-state.js';
import { createLogger } from './logger.js';

const log = createLogger('state');

interface SandboxState {
  processSnapshots: ProcessSnapshot[];
  editorState?: EditorState;
}

const FLUSH_DEBOUNCE_MS = 30_000;

let statePath: string = '/tmp/sandbox-state.json';
let registry: ProcessRegistry | null = null;
let editorManager: EditorStateManager | null = null;
let dirty = false;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

// --- Auto-save ---

export function markDirty(): void {
  dirty = true;
  if (flushTimer) {
    return;
  }
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushSync();
  }, FLUSH_DEBOUNCE_MS);
  flushTimer.unref();
}

function flushSync(): void {
  if (!dirty || !registry) {
    return;
  }
  try {
    const state: SandboxState = {
      processSnapshots: registry.getSnapshots(),
      editorState: editorManager?.getState(),
    };
    fsSync.writeFileSync(statePath, JSON.stringify(state), 'utf-8');
    dirty = false;
    log.debug(
      `Auto-saved (${state.processSnapshots.length} process snapshots)`,
    );
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

export function initState(
  workspaceDir: string,
  reg: ProcessRegistry,
  editor: EditorStateManager,
): void {
  statePath = path.join(workspaceDir, '.sandbox-state.json');
  registry = reg;
  editorManager = editor;
}

// --- Save / Restore ---

export async function saveState(): Promise<void> {
  if (!registry) {
    return;
  }
  try {
    stopAutoSave();
    const state: SandboxState = {
      processSnapshots: registry.getSnapshots(),
      editorState: editorManager?.getState(),
    };
    const json = JSON.stringify(state, null, 2);
    await fs.writeFile(statePath, json, 'utf-8');
    dirty = false;
    log.info(
      `Saved (${state.processSnapshots.length} process snapshots) → ${statePath}`,
    );
  } catch (err) {
    log.error(`Failed to save: ${err instanceof Error ? err.message : err}`);
  }
}

export async function restoreState(): Promise<boolean> {
  if (!registry) {
    return false;
  }
  try {
    const json = await fs.readFile(statePath, 'utf-8');
    const saved = JSON.parse(json);
    // Handle new format (processSnapshots)
    if (saved.processSnapshots && Array.isArray(saved.processSnapshots)) {
      registry.hydrate(saved.processSnapshots);
      if (saved.editorState && editorManager) {
        editorManager.hydrate(saved.editorState);
      }
      log.info(
        `Restored (${saved.processSnapshots.length} process snapshots) ← ${statePath}`,
      );
      return true;
    }
    // Old format (outputLog) — discard, can't meaningfully migrate
    log.info('Old state format found, starting fresh');
    return false;
  } catch {
    log.info(`No saved state found at ${statePath}`);
    return false;
  }
}
