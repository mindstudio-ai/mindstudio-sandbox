import { ctx } from '../context.ts';
import type { ActionHandler } from './index.ts';

export const editorHandlers: Record<string, ActionHandler> = {
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
};
