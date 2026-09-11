/**
 * Caches binary versions at boot so /status doesn't shell out per request.
 */

import { createRequire } from 'node:module';

import { createLogger } from '../logger.js';
import { findGlobalPackage } from '../utils/globalPackages.js';

const log = createLogger('versions');

// Our own version, read from package.json rather than restated as a literal — this used to be a
// hardcoded '0.1.0' that happened to agree with package.json and would have silently diverged the
// first time the package was released. `../../package.json` resolves to the package root from both
// dist/server/ (published) and src/server/ (tsx dev), and npm always ships package.json in the
// tarball regardless of the `files` list.
const ownVersion: string = (
  createRequire(import.meta.url)('../../package.json') as { version: string }
).version;

interface BinaryInfo {
  version: string;
  devBranch: string | null;
}

interface Versions {
  node: string;
  sandbox: string;
  remy: BinaryInfo;
  mindstudioLocal: BinaryInfo;
  agentSdk: BinaryInfo;
  typescriptLanguageServer: BinaryInfo;
}

const cached: Versions = {
  node: process.version,
  sandbox: ownVersion,
  remy: {
    version: 'unknown',
    devBranch: process.env['AGENT_DEV_BRANCH'] ?? null,
  },
  mindstudioLocal: {
    version: 'unknown',
    devBranch: process.env['TUNNEL_DEV_BRANCH'] ?? null,
  },
  agentSdk: {
    version: 'unknown',
    devBranch: process.env['AGENT_SDK_DEV_BRANCH'] ?? null,
  },
  typescriptLanguageServer: { version: 'unknown', devBranch: null },
};

const versionOf = (pkg: string): string =>
  findGlobalPackage(pkg)?.version ?? 'unknown';

/**
 * Read the installed versions. Call once, AFTER the home restore.
 *
 * Reads each package.json directly instead of shelling out to `npm list -g` four times, which cost
 * ~7s of boot and was on the critical path ahead of the restore. It was also giving wrong answers
 * twice over: `npm list -g` only sees the runtime prefix in $HOME, so every tool baked into the
 * image read as `unknown`, and running before the restore meant it described a home directory that
 * was about to be replaced. See `utils/globalPackages.ts`.
 */
export async function cacheVersions(): Promise<void> {
  cached.remy.version = versionOf('@mindstudio-ai/remy');
  cached.mindstudioLocal.version = versionOf(
    '@mindstudio-ai/local-model-tunnel',
  );
  cached.agentSdk.version = versionOf('@mindstudio-ai/agent');
  cached.typescriptLanguageServer.version = versionOf(
    'typescript-language-server',
  );
  log.info('Cached binary versions', { ...cached });
}

/** Return cached versions (call cacheVersions first). */
export function getVersions(): Versions {
  return { ...cached };
}
