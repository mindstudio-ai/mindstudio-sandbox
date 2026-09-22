import fsSync from 'node:fs';
import path from 'node:path';
import { createLogger } from '../../logger.ts';
import { parseJsonConfig } from '../../utils/jsonConfig.ts';
import type { ExternalToolHandler } from '../types.ts';

const log = createLogger('tool:setProjectMetadata');

export const setProjectMetadataTool: ExternalToolHandler = {
  handle(id, input, ctx) {
    const {
      name: newName,
      iconUrl,
      openGraphShareImageUrl,
      description,
    } = input as {
      name?: string;
      iconUrl?: string;
      openGraphShareImageUrl?: string;
      description?: string;
    };
    if (!newName && !iconUrl && !openGraphShareImageUrl && !description) {
      ctx.sendToolResult(id, 'error: at least one field required');
      return true;
    }
    try {
      const manifestPath = path.join(ctx.workspaceDir, 'mindstudio.json');
      const raw = fsSync.readFileSync(manifestPath, 'utf-8');
      // Tolerant parse; the canonical rewrite below doubles as the repair,
      // so a sloppy manifest is normalized as a side effect of any metadata
      // update rather than needing its own write path.
      const parsed = parseJsonConfig<Record<string, unknown>>(raw);
      if (!parsed.ok) {
        throw new Error(`mindstudio.json is not parseable: ${parsed.error}`);
      }
      const manifest = parsed.value;
      if (newName != null) {
        manifest.name = newName;
      }
      if (iconUrl != null) {
        manifest.iconUrl = iconUrl;
      }
      if (openGraphShareImageUrl != null) {
        manifest.openGraphShareImageUrl = openGraphShareImageUrl;
      }
      if (description != null) {
        manifest.description = description;
      }
      fsSync.writeFileSync(
        manifestPath,
        JSON.stringify(manifest, null, 2) + '\n',
        'utf-8',
      );
      void ctx.refreshAppConfig();
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
