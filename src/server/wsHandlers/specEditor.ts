import { ctx } from '../context.ts';
import type { ActionHandler } from './index.ts';

export const specEditorHandlers: Record<string, ActionHandler> = {
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
};
