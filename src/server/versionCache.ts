/**
 * Caches binary versions at boot so /status doesn't shell out per request.
 */

import { exec as execCb } from 'node:child_process';
import { createLogger } from '../logger.js';

const log = createLogger('versions');

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
  sandbox: '0.1.0',
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

function npmVersion(pkg: string): Promise<string> {
  return new Promise((resolve) => {
    execCb(
      `npm list -g ${pkg} --depth=0`,
      { encoding: 'utf-8', timeout: 10_000 },
      (err, stdout) => {
        // npm list exits non-zero when the package is missing, but still
        // prints output — try to parse either way.
        const output = stdout ?? '';
        const match = output.match(new RegExp(`${pkg}@(.+)`));
        resolve(match ? match[1].trim() : 'unknown');
      },
    );
  });
}

/** Shell out to get binary versions. Call once at boot. */
export async function cacheVersions(): Promise<void> {
  const [remy, tunnel, agentSdk, tls] = await Promise.all([
    npmVersion('@mindstudio-ai/remy'),
    npmVersion('@mindstudio-ai/local-model-tunnel'),
    npmVersion('@mindstudio-ai/agent'),
    npmVersion('typescript-language-server'),
  ]);
  cached.remy.version = remy;
  cached.mindstudioLocal.version = tunnel;
  cached.agentSdk.version = agentSdk;
  cached.typescriptLanguageServer.version = tls;
  log.info('Cached binary versions', { ...cached });
}

/** Return cached versions (call cacheVersions first). */
export function getVersions(): Versions {
  return { ...cached };
}
