// What only the tunnel does with the app manifest. Reading the manifest itself
// is `appConfig/read.ts`, shared with the C&C.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from '../logging/logger.ts';
import { readAppConfig } from '../../appConfig/read.ts';
import type { AppConfig } from '../../appConfig/types.ts';

const log = createLogger('config');

/**
 * The manifest as this process reads it: tolerantly, and never repairing on
 * disk. The C&C is the one writer of config files; a second one in another
 * process would race it on the same path for the same result.
 */
export function detectAppConfig(cwd: string): Promise<AppConfig | null> {
  return readAppConfig(cwd, { repair: false });
}

/**
 * Read the manifest, retrying until `predicate` is satisfied or attempts
 * are exhausted. Closes the race where a stdin command fires immediately
 * after a manifest edit — the disk write may be momentarily partial
 * (atomic-rename in flight) or recently completed but read before the
 * rename committed. Returns the last config seen (even if predicate
 * never satisfied), so callers can produce accurate "not found" errors.
 *
 * Defaults: 5 attempts × 60ms = ~300ms ceiling for genuinely-absent items.
 */
export async function detectAppConfigUntil(
  cwd: string,
  predicate: (config: AppConfig) => boolean,
  attempts = 5,
  delayMs = 60,
): Promise<AppConfig | null> {
  let last: AppConfig | null = null;
  for (let i = 0; i < attempts; i++) {
    const config = await detectAppConfig(cwd);
    if (config) {
      last = config;
      if (predicate(config)) {
        return config;
      }
    }
    if (i < attempts - 1) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  return last;
}

/**
 * Read raw TypeScript source for each table file listed in mindstudio.json.
 * Returns array of { name, source } for sending to sync-schema endpoint.
 * Skips files that don't exist.
 */
export function readTableSources(
  appConfig: AppConfig,
  cwd: string,
): Array<{ name: string; source: string }> {
  const results: Array<{ name: string; source: string }> = [];

  for (const table of appConfig.tables) {
    const filePath = join(cwd, table.path);
    if (!existsSync(filePath)) {
      log.warn('Table source file not found', {
        table: table.export,
        path: table.path,
      });
      continue;
    }

    try {
      const source = readFileSync(filePath, 'utf-8');
      // Use the export name as the table name for error reporting
      const name = table.export;
      results.push({ name, source });
    } catch (err) {
      log.warn('Table source file unreadable', {
        table: table.export,
        path: table.path,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (results.length < appConfig.tables.length) {
    log.warn('Table source files missing', {
      missing: appConfig.tables.length - results.length,
      found: results.length,
      expected: appConfig.tables.length,
    });
  }

  return results;
}
