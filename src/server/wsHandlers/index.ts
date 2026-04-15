/**
 * Action handler registry.
 *
 * Maps WebSocket action names to handler functions. Built-in handlers
 * are spread from focused modules; agent/tunnel handlers are merged in
 * at runtime via Object.assign when the process manager becomes available.
 */

import { readFile, writeFile, deleteFile, renameFile } from './filesystem.js';
import { shell } from './shell.js';
import {
  ptyCreate,
  ptyWrite,
  ptyResize,
  ptyClose,
  ptyGetScrollback,
} from './pty.js';
import { ctx } from '../context.js';
import { editorHandlers } from './editor.js';
import { specEditorHandlers } from './specEditor.js';
import { processHandlers } from './processes.js';
import { miscHandlers } from './misc.js';

export type ActionHandler = (
  params: Record<string, unknown>,
) => Promise<unknown>;

export const handlers: Record<string, ActionHandler> = {
  // --- Filesystem ---
  readFile: (p) => readFile(p as { path: string }),
  writeFile: async (p) => {
    const params = p as { path: string; content: string };
    const result = await writeFile(params);
    // Watcher events are suppressed for server-initiated writes,
    // so manually fire the shared handler. Use 'created' since
    // FileTreeManager ignores 'modified' — this could be a new file.
    ctx.onFileChanged?.(params.path, 'created');
    return result;
  },
  deleteFile: async (p) => {
    const params = p as { path: string };
    const result = await deleteFile(params);
    ctx.onFileChanged?.(params.path, 'deleted');
    return result;
  },
  renameFile: async (p) => {
    const params = p as { oldPath: string; newPath: string };
    const result = await renameFile(params);
    ctx.editorState?.onFileRenamed(params.oldPath, params.newPath);
    ctx.specEditorState?.onFileRenamed(params.oldPath, params.newPath);
    // Re-open renamed file in LSP if it was being tracked
    if (ctx.lspClient?.isFileOpen(ctx.lspClient.pathToUri(params.oldPath))) {
      ctx.lspClient.closeFile(params.oldPath);
      ctx.lspClient.ensureFileOpen(params.newPath).catch(() => {});
    }
    ctx.onFileChanged?.(params.oldPath, 'deleted');
    ctx.onFileChanged?.(params.newPath, 'created');
    return result;
  },
  shell: (p) => shell(p as { command: string; cwd?: string; timeout?: number }),

  // --- Editor ---
  ...editorHandlers,

  // --- Spec Editor ---
  ...specEditorHandlers,

  // --- Processes ---
  ...processHandlers,

  // --- PTY ---
  ptyCreate: (p) =>
    ptyCreate(p as { cols?: number; rows?: number; cwd?: string }),
  ptyWrite: (p) => ptyWrite(p as { sessionId: string; data: string }),
  ptyResize: (p) =>
    ptyResize(p as { sessionId: string; cols: number; rows: number }),
  ptyClose: (p) => ptyClose(p as { sessionId: string }),
  ptyGetScrollback: (p) => ptyGetScrollback(p as { sessionId: string }),

  // --- Misc ---
  ...miscHandlers,

  // Agent and tunnel actions are merged in at runtime via Object.assign
};
