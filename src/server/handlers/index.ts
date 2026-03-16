/**
 * Action handler registry.
 *
 * Maps WebSocket action names to handler functions. Built-in handlers
 * are defined here; agent/tunnel handlers are merged in at runtime
 * via Object.assign when the process manager becomes available.
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
import { createLogger } from '../../logger.js';

const log = createLogger('handlers');

export type ActionHandler = (
  params: Record<string, unknown>,
) => Promise<unknown>;

export const handlers: Record<string, ActionHandler> = {
  // --- Filesystem ---
  readFile: (p) => readFile(p as { path: string }),
  writeFile: (p) => writeFile(p as { path: string; content: string }),
  deleteFile: async (p) => {
    const params = p as { path: string };
    const result = await deleteFile(params);
    ctx.editorState?.onFileDeleted(params.path);
    return result;
  },
  renameFile: async (p) => {
    const params = p as { oldPath: string; newPath: string };
    const result = await renameFile(params);
    ctx.editorState?.onFileRenamed(params.oldPath, params.newPath);
    return result;
  },
  shell: (p) => shell(p as { command: string; cwd?: string; timeout?: number }),

  // --- Processes ---
  getProcesses: async () => {
    return { processes: ctx.processManager?.getProcesses() ?? [] };
  },
  restartProcess: async (p) => {
    const { name } = p as { name: string };
    if (!name) {
      throw new Error('Missing "name" parameter');
    }
    if (!ctx.processManager) {
      throw new Error('Process manager not initialized');
    }
    log.info(`Restarting process: ${name}`);
    await ctx.processManager.restart(name);
    return {};
  },
  getProcessLog: async (p) => {
    const { name } = p as { name: string };
    if (!name) {
      throw new Error('Missing "name" parameter');
    }
    return { log: ctx.processManager?.getProcessLog(name) ?? [] };
  },

  // --- Editor ---
  openFile: async (p) => {
    const { path, preview } = p as { path: string; preview?: boolean };
    if (!path) {
      throw new Error('Missing "path" parameter');
    }
    ctx.editorState?.openFile(path, preview ?? false);
    return {};
  },
  closeFile: async (p) => {
    const { path } = p as { path: string };
    if (!path) {
      throw new Error('Missing "path" parameter');
    }
    ctx.editorState?.closeFile(path);
    return {};
  },
  setActiveTab: async (p) => {
    const { path } = p as { path: string };
    if (!path) {
      throw new Error('Missing "path" parameter');
    }
    ctx.editorState?.setActiveTab(path);
    return {};
  },
  reorderTabs: async (p) => {
    const { paths } = p as { paths: string[] };
    if (!Array.isArray(paths)) {
      throw new Error('Missing "paths" parameter (array of file paths)');
    }
    ctx.editorState?.reorderTabs(paths);
    return {};
  },
  expandDir: async (p) => {
    const { path } = p as { path: string };
    if (!path) {
      throw new Error('Missing "path" parameter');
    }
    ctx.editorState?.expandDir(path);
    return {};
  },
  collapseDir: async (p) => {
    const { path } = p as { path: string };
    if (!path) {
      throw new Error('Missing "path" parameter');
    }
    ctx.editorState?.collapseDir(path);
    return {};
  },
  toggleDir: async (p) => {
    const { path } = p as { path: string };
    if (!path) {
      throw new Error('Missing "path" parameter');
    }
    ctx.editorState?.toggleDir(path);
    return {};
  },

  // --- Spec Editor ---
  specOpenFile: async (p) => {
    const { path, preview } = p as { path: string; preview?: boolean };
    if (!path) {
      throw new Error('Missing "path" parameter');
    }
    ctx.specEditorState?.openFile(path, preview ?? false);
    return {};
  },
  specCloseFile: async (p) => {
    const { path } = p as { path: string };
    if (!path) {
      throw new Error('Missing "path" parameter');
    }
    ctx.specEditorState?.closeFile(path);
    return {};
  },
  specSetActiveTab: async (p) => {
    const { path } = p as { path: string };
    if (!path) {
      throw new Error('Missing "path" parameter');
    }
    ctx.specEditorState?.setActiveTab(path);
    return {};
  },

  // --- View mode ---
  setViewMode: async (p) => {
    const { mode } = p as { mode: string };
    if (mode !== 'code' && mode !== 'spec') {
      throw new Error('Invalid mode — expected "code" or "spec"');
    }
    ctx.viewMode = mode;
    return {};
  },

  // --- Resources ---
  getResources: async () => {
    return ctx.resourceMonitor?.collectNow() ?? {};
  },

  // --- PTY ---
  ptyCreate: (p) =>
    ptyCreate(p as { cols?: number; rows?: number; cwd?: string }),
  ptyWrite: (p) => ptyWrite(p as { sessionId: string; data: string }),
  ptyResize: (p) =>
    ptyResize(p as { sessionId: string; cols: number; rows: number }),
  ptyClose: (p) => ptyClose(p as { sessionId: string }),
  ptyGetScrollback: (p) => ptyGetScrollback(p as { sessionId: string }),

  // Agent and tunnel actions are merged in at runtime via Object.assign
};
