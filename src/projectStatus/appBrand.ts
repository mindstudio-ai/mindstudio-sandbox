/**
 * Opaque AppBrand object from `.remy-brand.json`. Written by an upstream
 * extractor (remy) via tmp+rename. The frontend owns the schema (version,
 * name, tagline, logoUrl, colors, typography) — the sandbox just parses
 * the file and forwards the whole object.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

export type AppBrand = Record<string, unknown>;

export async function readAppBrand(
  workspaceDir: string,
): Promise<AppBrand | null> {
  try {
    const raw = await fs.readFile(
      path.join(workspaceDir, '.remy-brand.json'),
      'utf-8',
    );
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as AppBrand) : null;
  } catch {
    return null;
  }
}
