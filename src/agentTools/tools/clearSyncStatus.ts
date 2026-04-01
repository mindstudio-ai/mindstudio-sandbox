import { clearSyncStatus } from '../../projectStatus/ProjectStatusManager.js';
import type { ExternalToolHandler } from '../types.js';

export const clearSyncStatusTool: ExternalToolHandler = {
  handle(id, _input, ctx) {
    if (clearSyncStatus()) {
      ctx.broadcast('projectStatusChanged', ctx.getProjectStatus());
    }
    ctx.sendToolResult(id, 'ok');
    return true;
  },
};
