/**
 * Configuration, read once at startup from the environment and the workspace.
 *
 * Deliberately does NOT go through the server's `loadConfig()`: that requires
 * GIT_REPO_URL and USER_ID, and it logs NDJSON to stdout — which would corrupt
 * this CLI's output contract.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fatal } from './errors.js';
import { parseJsonConfig } from '../utils/parseJsonConfig.js';

export const API_KEY = process.env['MINDSTUDIO_API_KEY'] ?? '';
export const API_BASE =
  process.env['API_BASE_URL'] || 'https://api.mindstudio.ai';
export const WORKSPACE_DIR =
  process.env['WORKSPACE_DIR'] || '/home/vercel-sandbox/workspace';

export function loadAppId(): string {
  const manifestPath = path.join(WORKSPACE_DIR, 'mindstudio.json');
  let raw: string;
  try {
    raw = fs.readFileSync(manifestPath, 'utf-8');
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      fatal(`mindstudio.json not found at ${manifestPath}`);
    }
    fatal(`Failed to read mindstudio.json: ${err.message}`);
  }
  // Tolerant parse, but deliberately read-only: this is a short-lived CLI and
  // shouldn't mutate the workspace out from under the running sandbox. The
  // sandbox repairs the file on its own read path.
  const result = parseJsonConfig<{ appId?: string }>(raw);
  if (!result.ok) {
    fatal(`Failed to parse mindstudio.json: ${result.error}`);
  }
  if (!result.value.appId) {
    fatal('mindstudio.json exists but has no appId');
  }
  return result.value.appId;
}
