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

function execVersion(cmd: string): Promise<string> {
  return new Promise((resolve) => {
    execCb(cmd, { encoding: 'utf-8', timeout: 5_000 }, (err, stdout) => {
      if (err) {
        resolve('unknown');
        return;
      }
      resolve(stdout.trim());
    });
  });
}

/** Shell out to get binary versions. Call once at boot. */
export async function cacheVersions(): Promise<void> {
  const [remy, tunnel, agentSdk, tls] = await Promise.all([
    execVersion('remy --version'),
    execVersion('mindstudio-local --version'),
    execVersion('npm list -g @mindstudio-ai/agent --depth=0'),
    execVersion('typescript-language-server --version'),
  ]);
  cached.remy.version = remy;
  cached.mindstudioLocal.version = tunnel;
  cached.agentSdk.version =
    agentSdk.match(/@mindstudio-ai\/agent@(.+)/)?.[1] ?? agentSdk;
  cached.typescriptLanguageServer.version = tls;
  log.info('Cached binary versions', { ...cached });
}

/** Return cached versions (call cacheVersions first). */
export function getVersions(): Versions {
  return { ...cached };
}
