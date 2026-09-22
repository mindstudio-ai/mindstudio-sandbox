/**
 * Persistent sandbox state, written to the workspace so it survives a C&C server restart.
 *
 * Stores process registry snapshots (metadata + per-process logs).
 * Chat history is owned by remy (fetched via get_history action).
 *
 * Auto-save: state is flushed synchronously (writeFileSync) after
 * mutations, debounced to avoid thrashing, so a crash loses at most the
 * debounce window.
 */

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import type {
  ProcessRegistry,
  ProcessSnapshot,
} from './processes/ProcessRegistry.ts';
import type {
  EditorStateManager,
  EditorState,
} from './server/states/EditorStateManager.ts';
import type {
  SpecEditorStateManager,
  SpecEditorState,
} from './server/states/SpecEditorStateManager.ts';
import { createLogger } from './logger.ts';

const log = createLogger('state');

interface SandboxState {
  processSnapshots: ProcessSnapshot[];
  editorState?: EditorState;
  specEditorState?: SpecEditorState;
}

const FLUSH_DEBOUNCE_MS = 30_000;

let statePath: string = '/tmp/sandbox-state.json';
let registry: ProcessRegistry | null = null;
let editorManager: EditorStateManager | null = null;
let specEditorManager: SpecEditorStateManager | null = null;
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

function buildState(): SandboxState {
  return {
    processSnapshots: registry!.getSnapshots(),
    editorState: editorManager?.getState(),
    specEditorState: specEditorManager?.getState(),
  };
}

function flushSync(): void {
  if (!dirty || !registry) {
    return;
  }
  try {
    const state = buildState();
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
  specEditor: SpecEditorStateManager,
): void {
  statePath = path.join(workspaceDir, '.sandbox-state.json');
  registry = reg;
  editorManager = editor;
  specEditorManager = specEditor;
}

// --- Save / Restore ---

export async function saveState(): Promise<void> {
  if (!registry) {
    return;
  }
  try {
    stopAutoSave();
    const state = buildState();
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
      if (saved.specEditorState && specEditorManager) {
        specEditorManager.hydrate(saved.specEditorState);
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
