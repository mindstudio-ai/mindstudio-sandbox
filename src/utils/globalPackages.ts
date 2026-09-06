/**
 * Locate a globally-installed npm package, across BOTH of a dev box's global prefixes.
 *
 * A box has two, and this is the whole reason this file exists:
 *
 *   /usr/local/lib/node_modules        the tooling BAKED INTO THE IMAGE, installed as root
 *   $HOME/.npm-global/lib/node_modules `NPM_CONFIG_PREFIX` at runtime, so the box's own user can
 *                                      `npm install -g` without write access to /usr/local
 *
 * See `worker/Dockerfile.devbox` — the prefix is switched AFTER the baked install, deliberately, so
 * an override shadows a baked tool rather than replacing it.
 *
 * `npm list -g` consults ONLY the second prefix. Anything that used it to ask "is this installed?"
 * therefore got `no` for every baked package, and anything that used it to read a version got
 * `unknown`. That cost a boot ~1s re-installing an SDK the image already had (into a directory the
 * home-snapshot restore then overwrote, so the fresh copy did not even survive) and ~7s of
 * `npm list -g` walking the global tree four times for strings `/status` reports.
 *
 * Searched home-first, matching how PATH resolves a binary, so a user's override is what gets
 * reported — the same precedence the box actually executes with.
 */

import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** `NPM_CONFIG_PREFIX` at runtime. INSIDE the home snapshot, so anything here is frozen per app. */
export const HOME_GLOBAL_NODE_MODULES = path.join(
  os.homedir(),
  '.npm-global',
  'lib',
  'node_modules',
);

/** Where the image installs baked tooling as root. Outside the snapshot, so always the image's. */
export const IMAGE_GLOBAL_NODE_MODULES = '/usr/local/lib/node_modules';

const GLOBAL_NODE_MODULES = [
  HOME_GLOBAL_NODE_MODULES,
  IMAGE_GLOBAL_NODE_MODULES,
];

export interface GlobalPackage {
  /** Absolute path to the package directory that would win on PATH. */
  dir: string;
  /** `version` from its package.json, or 'unknown' if unreadable. */
  version: string;
}

/**
 * The package as it would resolve on this box, or null if it is in neither prefix.
 *
 * A file read rather than a subprocess: scoped packages are a nested directory (`@scope/name`),
 * which `path.join` handles for free via the split.
 */
export function findGlobalPackage(
  pkg: string,
  roots: string[] = GLOBAL_NODE_MODULES,
): GlobalPackage | null {
  for (const root of roots) {
    const dir = path.join(root, ...pkg.split('/'));
    try {
      const raw = fsSync.readFileSync(path.join(dir, 'package.json'), 'utf-8');
      return { dir, version: JSON.parse(raw).version ?? 'unknown' };
    } catch {
      // Absent from this prefix, or a package.json we cannot parse. Either way, keep looking:
      // finding it in the next prefix is a better answer than failing here.
    }
  }
  return null;
}
