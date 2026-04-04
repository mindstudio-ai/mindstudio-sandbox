import fsSync from 'node:fs';
import path from 'node:path';
import { createLogger } from '../../logger.js';
import type { ExternalToolHandler } from '../types.js';

const log = createLogger('tool:setProjectMetadata');

export const setProjectMetadataTool: ExternalToolHandler = {
  handle(id, input, ctx) {
    const {
      name: newName,
      iconUrl,
      openGraphShareImageUrl,
      shortDescription,
    } = input as {
      name?: string;
      iconUrl?: string;
      openGraphShareImageUrl?: string;
      shortDescription?: string;
    };
    if (!newName && !iconUrl && !openGraphShareImageUrl && !shortDescription) {
      ctx.sendToolResult(id, 'error: at least one field required');
      return true;
    }
    try {
      const manifestPath = path.join(ctx.workspaceDir, 'mindstudio.json');
      const raw = fsSync.readFileSync(manifestPath, 'utf-8');
      const manifest = JSON.parse(raw);
      if (newName != null) {
        manifest.name = newName;
      }
      if (iconUrl != null) {
        manifest.iconUrl = iconUrl;
      }
      if (openGraphShareImageUrl != null) {
        manifest.openGraphShareImageUrl = openGraphShareImageUrl;
      }
      if (shortDescription != null) {
        manifest.shortDescription = shortDescription;
      }
      fsSync.writeFileSync(
        manifestPath,
        JSON.stringify(manifest, null, 2) + '\n',
        'utf-8',
      );
      ctx
        .readAppConfig()
        .then((updated) => {
          if (updated) {
            ctx.setAppConfig(updated);
            ctx.broadcast('manifestChanged', { app: updated });
          }
        })
        .catch(() => {});
      const fields = [
        newName && 'name',
        iconUrl && 'iconUrl',
        openGraphShareImageUrl && 'openGraphShareImageUrl',
      ].filter(Boolean);
      log.info(`Project metadata updated: ${fields.join(', ')}`, {
        toolCallId: id,
      });
    } catch (err) {
      log.error(
        `Failed to update project metadata: ${err instanceof Error ? err.message : err}`,
        { toolCallId: id },
      );
    }
    ctx.sendToolResult(id, 'ok');
    return true;
  },
};
