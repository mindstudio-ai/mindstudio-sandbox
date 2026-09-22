/**
 * Re-read `mindstudio.json` and tell the editor.
 *
 * This existed four times — after a watcher event, after an agent turn, after
 * the `setProjectMetadata` tool wrote the file, and forged as a fake file event
 * on a manual dev-server restart — three of them commented "chokidar may miss
 * changes". One function, and the forged event is gone: a caller that wants the
 * manifest re-read says so.
 */

import { readAppConfig } from '../appConfig/read.ts';
import { ctx } from './context.ts';
import { broadcast } from './index.ts';

export async function refreshAppConfig(): Promise<void> {
  if (!ctx.workspaceDir) {
    return;
  }
  // The C&C is the one process that repairs config files on disk.
  const updated = await readAppConfig(ctx.workspaceDir, { repair: true });
  if (updated) {
    ctx.appConfig = updated;
    broadcast('manifestChanged', { app: updated });
  }
}
