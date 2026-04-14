import { exec, execSync } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Config } from '../config.js';
import type { AppConfig } from '../types.js';
import type { ProcessRegistry } from '../processes/ProcessRegistry.js';
import { createLogger } from '../logger.js';
import {
  run,
  runAsync,
  isInstalled,
  verifyInstalled,
  installFromSource,
  setRegistry,
} from './helpers.js';

const log = createLogger('bootstrap');

type ProgressFn = (step: string, message: string) => void;

export function setBootstrapRegistry(r: ProcessRegistry): void {
  setRegistry(r);
}

// ---------------------------------------------------------------------------
// Binary installers
// ---------------------------------------------------------------------------

export async function installTunnel(progress: ProgressFn): Promise<void> {
  const devBranch = process.env['TUNNEL_DEV_BRANCH'];

  if (!devBranch && isInstalled('mindstudio-local')) {
    progress('installTunnel', 'Already installed, skipping');
    log.info('mindstudio-local already installed, skipping');
    return;
  }

  if (devBranch) {
    progress(
      'installTunnel',
      `Installing tunnel from source (${devBranch})...`,
    );
    installFromSource({
      repoUrl:
        'https://github.com/mindstudio-ai/mindstudio-local-model-tunnel.git',
      branch: devBranch,
      tmpDir: '/tmp/mindstudio-local-tunnel',
      label: 'tunnel',
    });
  } else {
    progress('installTunnel', 'Installing mindstudio-local tunnel...');
    run('npm install -g @mindstudio-ai/local-model-tunnel', {
      label: 'npm install -g @mindstudio-ai/local-model-tunnel',
    });
  }

  verifyInstalled('mindstudio-local');
}

export async function installAgent(progress: ProgressFn): Promise<void> {
  const devBranch = process.env['AGENT_DEV_BRANCH'];

  if (!devBranch && isInstalled('remy')) {
    progress('installAgent', 'Already installed, skipping');
    log.info('remy already installed, skipping');
    return;
  }

  if (devBranch) {
    progress('installAgent', `Installing remy from source (${devBranch})...`);
    installFromSource({
      repoUrl: 'https://github.com/mindstudio-ai/remy.git',
      branch: devBranch,
      tmpDir: '/tmp/remy',
      label: 'remy',
    });
  } else {
    progress('installAgent', 'Installing remy agent...');
    run('npm install -g @mindstudio-ai/remy', {
      label: 'npm install -g @mindstudio-ai/remy',
    });
  }

  verifyInstalled('remy');
}

export async function installAgentSdk(progress: ProgressFn): Promise<void> {
  const devBranch = process.env['AGENT_SDK_DEV_BRANCH'];

  if (!devBranch) {
    try {
      execSync('npm list -g @mindstudio-ai/agent', {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      progress('installAgentSdk', 'Already installed, skipping');
      log.info('agent SDK already installed, skipping');
      return;
    } catch {
      // Not installed, proceed with install
    }
  }

  if (devBranch) {
    progress(
      'installAgentSdk',
      `Installing agent SDK from source (${devBranch})...`,
    );
    installFromSource({
      repoUrl: 'https://github.com/mindstudio-ai/mindstudio-agent.git',
      branch: devBranch,
      tmpDir: '/tmp/mindstudio-agent',
      label: 'agent-sdk',
    });
  } else {
    progress('installAgentSdk', 'Installing MindStudio agent SDK...');
    run('npm install -g @mindstudio-ai/agent', {
      label: 'npm install -g @mindstudio-ai/agent',
    });
  }
}

export async function installLsp(progress: ProgressFn): Promise<void> {
  if (isInstalled('typescript-language-server')) {
    progress('installLsp', 'Already installed, skipping');
    log.info('typescript-language-server already installed, skipping');
    return;
  }

  progress('installLsp', 'Installing TypeScript language server...');
  run('npm install -g typescript-language-server typescript', {
    label: 'npm install -g typescript-language-server typescript',
  });

  verifyInstalled('typescript-language-server');
}

// ---------------------------------------------------------------------------
// Workspace setup
// ---------------------------------------------------------------------------

export async function writeTunnelConfig(config: Config): Promise<void> {
  const configDir = path.join(os.homedir(), '.mindstudio-local-tunnel');
  const configPath = path.join(configDir, 'config.json');
  log.debug(`Writing tunnel config to ${configPath}`);

  await fs.mkdir(configDir, { recursive: true });

  const configData = {
    environment: 'prod',
    environments: {
      prod: {
        apiBaseUrl: config.apiBaseUrl,
        apiKey: config.apiKey,
        userId: config.userId,
      },
      local: {
        apiBaseUrl: 'http://localhost:3129',
      },
    },
    providerBaseUrls: {},
    providerInstallPaths: {},
    localInterfaces: {},
  };

  await fs.writeFile(configPath, JSON.stringify(configData, null, 2), 'utf-8');
  log.info(
    `Tunnel config written (apiBaseUrl=${config.apiBaseUrl}, userId=${config.userId})`,
  );
}

export async function cloneAppRepo(
  config: Config,
  progress: ProgressFn,
): Promise<void> {
  const { workspaceDir, gitRepoUrl } = config;
  const gitDir = path.join(workspaceDir, '.git');

  // If the snapshot baked in the scaffold, the workspace already exists with
  // a .git dir pointing at the GitHub scaffold repo. Switch to the user's
  // repo via fetch+reset so node_modules (gitignored) survives intact.
  const hasGit = fsSync.existsSync(gitDir);

  if (hasGit) {
    progress('cloneApp', 'Syncing workspace to app repo...');
    log.info(`Workspace has .git, switching remote to ${gitRepoUrl}`);
    run(`git remote set-url origin ${gitRepoUrl}`, {
      cwd: workspaceDir,
      label: 'git remote set-url',
    });
    run('git fetch --depth 1 origin main', {
      cwd: workspaceDir,
      label: 'git fetch origin main',
    });
    run('git reset --hard origin/main', {
      cwd: workspaceDir,
      label: 'git reset --hard origin/main',
    });
  } else {
    progress('cloneApp', 'Cloning app repo...');
    log.debug(`Creating workspace dir: ${workspaceDir}`);
    await fs.mkdir(workspaceDir, { recursive: true });
    log.info(`Cloning ${gitRepoUrl} → ${workspaceDir}`);
    run(`git clone --depth 1 ${gitRepoUrl} ${workspaceDir}`, {
      label: `git clone → ${workspaceDir}`,
    });
  }

  // Verify workspace has a manifest
  const manifestPath = path.join(workspaceDir, 'mindstudio.json');
  try {
    await fs.access(manifestPath);
    log.info('Workspace ready — mindstudio.json found');
  } catch {
    log.warn('Workspace ready but mindstudio.json not found');
    try {
      const files = await fs.readdir(workspaceDir);
      log.warn(`Workspace contents: ${files.join(', ')}`);
    } catch (e) {
      log.error(`Cannot list workspace: ${e}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Git configuration
// ---------------------------------------------------------------------------

function unshallowAsync(workspaceDir: string): void {
  const start = Date.now();
  exec(
    'git fetch --unshallow',
    { cwd: workspaceDir, encoding: 'utf-8', timeout: 120_000 },
    (err) => {
      const elapsed = Date.now() - start;
      if (err) {
        log.info(
          `git fetch --unshallow skipped in ${elapsed}ms (repo already has full history or fetch failed)`,
        );
      } else {
        log.info(`git fetch --unshallow completed in ${elapsed}ms`);
      }
    },
  );
}

export function configureGit(workspaceDir: string): void {
  const metadataEnv: {
    userName: string;
    userEmail: string;
  } = process.env['USER_METADATA']
    ? JSON.parse(process.env['USER_METADATA'])
    : {
        userName: 'MindStudio',
        userEmail: 'noreply@mindstudio.ai',
      };

  // Git refuses commits with an empty ident name — fall back to defaults
  if (!metadataEnv.userName?.trim()) {
    metadataEnv.userName = 'MindStudio';
  }
  if (!metadataEnv.userEmail?.trim()) {
    metadataEnv.userEmail = 'noreply@mindstudio.ai';
  }

  run(`git config user.name "${metadataEnv.userName}"`, {
    cwd: workspaceDir,
    label: 'git config user.name',
  });
  run(`git config user.email "${metadataEnv.userEmail}"`, {
    cwd: workspaceDir,
    label: 'git config user.email',
  });

  // Prevent git from ever opening an interactive editor (would hang in sandbox)
  run('git config core.editor true', {
    cwd: workspaceDir,
    label: 'git config core.editor',
  });

  // Prevent git from using a pager (less may not be installed, would hang)
  run('git config core.pager cat', {
    cwd: workspaceDir,
    label: 'git config core.pager',
  });

  // Avoid "dubious ownership" errors in container environments
  run('git config --global safe.directory "*"', {
    label: 'git config safe.directory',
  });

  // Unshallow so remy can see full history for diffs and commits.
  // Runs in the background — nothing in boot needs deep history, and remy
  // only needs it when the user first asks for a diff/commit.
  unshallowAsync(workspaceDir);

  // Install commit-msg hook to add Remy as coauthor on all commits
  const hooksDir = path.join(workspaceDir, '.git', 'hooks');
  const hookPath = path.join(hooksDir, 'commit-msg');
  const hook = [
    '#!/bin/sh',
    '# Added by sandbox — tag Remy as coauthor on all commits',
    'if ! grep -q "^Co-Authored-By: Remy" "$1"; then',
    '  echo "" >> "$1"',
    '  echo "Co-Authored-By: Remy <remy@mindstudio.ai>" >> "$1"',
    'fi',
  ].join('\n');
  try {
    fsSync.mkdirSync(hooksDir, { recursive: true });
    fsSync.writeFileSync(hookPath, hook, { mode: 0o755 });
    log.info('Installed commit-msg hook (Remy coauthor)');
  } catch (err) {
    log.warn(`Failed to install commit-msg hook: ${err}`);
  }
}

// ---------------------------------------------------------------------------
// CLI tools
// ---------------------------------------------------------------------------

export function linkProdCli(): void {
  const cliSource = '/vercel/sandbox/dist/cli/prod.js';
  const binDir = path.join(os.homedir(), '.local', 'bin');
  const cliTarget = path.join(binDir, 'mindstudio-prod');

  try {
    // tsc outputs 644 — make executable so the shebang works
    fsSync.chmodSync(cliSource, 0o755);
    fsSync.mkdirSync(binDir, { recursive: true });
    // Remove stale symlink if present (e.g., pointing to old path)
    try {
      fsSync.unlinkSync(cliTarget);
    } catch {
      // doesn't exist yet
    }
    fsSync.symlinkSync(cliSource, cliTarget);
    log.info('Linked mindstudio-prod CLI');
  } catch (err) {
    log.warn(`Failed to link mindstudio-prod CLI: ${err}`);
  }
}

// ---------------------------------------------------------------------------
// App config
// ---------------------------------------------------------------------------

export async function readAppConfig(
  workspaceDir: string,
): Promise<AppConfig | null> {
  const manifestPath = path.join(workspaceDir, 'mindstudio.json');
  log.debug(`Reading app config from ${manifestPath}`);

  let raw: string;
  try {
    raw = await fs.readFile(manifestPath, 'utf-8');
  } catch {
    log.error(`App config not found at ${manifestPath}`);
    return null;
  }

  let config: AppConfig;
  try {
    // Parse the full manifest — AppConfig is the typed subset but we
    // store the complete object so we can forward it to clients
    config = JSON.parse(raw) as AppConfig;
  } catch (err) {
    log.error(
      `Failed to parse app config: ${err instanceof Error ? err.message : err}`,
    );
    return null;
  }

  log.info(`App: "${config.name}" (${config.appId})`);
  log.debug(
    `  Methods: ${config.methods?.length ?? 0} (${config.methods?.map((m) => m.id).join(', ') || 'none'})`,
  );
  log.debug(
    `  Tables: ${config.tables?.length ?? 0} (${config.tables?.map((t) => t.export).join(', ') || 'none'})`,
  );
  log.debug(
    `  Interfaces: ${config.interfaces?.length ?? 0} (${config.interfaces?.map((i) => i.type).join(', ') || 'none'})`,
  );

  // Resolve interface configs — read each config file and extract the
  // inner object keyed by type (e.g. web.json → { "web": {...} } → {...}).
  // Mirrors the deploy pipeline's readManifestFromRepo behavior.
  for (const iface of config.interfaces ?? []) {
    try {
      const configPath = path.join(workspaceDir, iface.path);
      const raw = await fs.readFile(configPath, 'utf-8');
      const parsed = JSON.parse(raw);
      const inner = parsed[iface.type];
      if (inner && typeof inner === 'object') {
        iface.config = inner;
        log.debug(`  ${iface.type} config resolved from ${iface.path}`);
      }
    } catch {
      log.debug(`  ${iface.type} config not found at ${iface.path}`);
    }
  }

  return config;
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export async function installDependencies(
  workspaceDir: string,
  progress: ProgressFn,
): Promise<void> {
  const packageDirs = [
    path.join(workspaceDir, 'dist', 'methods'),
    path.join(workspaceDir, 'dist', 'interfaces', 'web'),
  ];

  log.debug('Scanning for package.json files...');

  const installDirs: string[] = [];
  for (const dir of packageDirs) {
    const pkgPath = path.join(dir, 'package.json');
    try {
      await fs.access(pkgPath);
      log.debug(`  Found: ${pkgPath}`);
      installDirs.push(dir);
    } catch {
      log.debug(`  Not found: ${pkgPath}`);
    }
  }

  if (installDirs.length === 0) {
    log.info('No package.json files found, skipping install');
    return;
  }

  progress(
    'installDeps',
    `Installing dependencies in ${installDirs.length} directories...`,
  );

  const startTime = Date.now();
  await Promise.all(
    installDirs.map((dir) =>
      runAsync('npm install', { cwd: dir, label: `npm install in ${dir}` }),
    ),
  );
  const elapsed = Date.now() - startTime;
  log.info(`All npm installs completed in ${elapsed}ms`);
}
