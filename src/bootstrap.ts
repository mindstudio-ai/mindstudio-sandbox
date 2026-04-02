import { execSync, type ExecSyncOptions } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { Config } from './config.js';
import type { AppConfig } from './types.js';
import type { ProcessRegistry } from './processes/ProcessRegistry.js';
import { createLogger } from './logger.js';

const log = createLogger('bootstrap');

let registry: ProcessRegistry | null = null;

export function setBootstrapRegistry(r: ProcessRegistry): void {
  registry = r;
}

type ProgressFn = (step: string, message: string) => void;

function run(cmd: string, opts?: ExecSyncOptions & { label?: string }): string {
  const label = opts?.label ?? cmd;
  const procName = `bootstrap:${(label ?? cmd).replace(/\s+/g, '-').slice(0, 60)}`;

  registry?.register(procName, 'task', cmd);
  registry?.setState(procName, 'running');

  log.info(`Running: ${label}`);
  const startTime = Date.now();
  try {
    const result = execSync(cmd, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 300000, // 5 minutes
      ...opts,
    }) as string;
    const elapsed = Date.now() - startTime;
    log.info(`Completed in ${elapsed}ms: ${label}`);
    if (result.trim()) {
      for (const line of result.trim().split('\n')) {
        registry?.appendLog(procName, line);
      }
    }
    registry?.setState(procName, 'completed', { exitCode: 0 });
    return result;
  } catch (err: unknown) {
    const elapsed = Date.now() - startTime;
    const execErr = err as {
      stderr?: string;
      stdout?: string;
      status?: number;
      message?: string;
    };
    log.error(`FAILED after ${elapsed}ms: ${label}`);
    log.error(`  Exit code: ${execErr.status}`);
    if (execErr.stderr) {
      for (const line of execErr.stderr.trim().split('\n')) {
        registry?.appendLog(procName, line, { level: 'error' });
      }
    }
    if (execErr.stdout) {
      for (const line of execErr.stdout.trim().split('\n')) {
        registry?.appendLog(procName, line);
      }
    }
    registry?.setState(procName, 'crashed', { exitCode: execErr.status ?? 1 });
    throw err;
  }
}

function isInstalled(binaryName: string): boolean {
  try {
    execSync(`which ${binaryName}`, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

function verifyInstalled(binaryName: string): void {
  if (isInstalled(binaryName)) {
    log.info(
      `${binaryName} installed at: ${execSync(`which ${binaryName}`, { encoding: 'utf-8' }).trim()}`,
    );
  } else {
    log.warn(`${binaryName} not found after install`);
  }
}

/**
 * Clone a git repo, build from source, and npm install -g the result.
 * Used for dev branches where the published npm package won't work.
 */
function installFromSource(opts: {
  repoUrl: string;
  branch: string;
  tmpDir: string;
  label: string;
}): void {
  run(`rm -rf ${opts.tmpDir}`, { label: `Clean ${opts.label} dir` });
  run(
    `git clone --depth 1 --branch ${opts.branch} ${opts.repoUrl} ${opts.tmpDir}`,
    { label: `git clone ${opts.label} (${opts.branch})` },
  );
  run('npm install', {
    cwd: opts.tmpDir,
    label: `npm install in ${opts.label}`,
  });
  run('npm run build', {
    cwd: opts.tmpDir,
    label: `npm run build in ${opts.label}`,
  });
  run(`npm install -g ${opts.tmpDir}`, {
    label: `npm install -g (link built ${opts.label})`,
  });
}

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
  const manifestPath = path.join(config.workspaceDir, 'mindstudio.json');
  log.debug(`Checking for ${manifestPath}...`);

  // Skip if workspace already has a mindstudio.json
  try {
    await fs.access(manifestPath);
    log.info('mindstudio.json exists, skipping clone');
    return;
  } catch {
    log.info('mindstudio.json not found, will clone');
  }

  progress('cloneApp', `Cloning app repo...`);
  log.debug(`Creating workspace dir: ${config.workspaceDir}`);
  await fs.mkdir(config.workspaceDir, { recursive: true });
  log.info(`Cloning ${config.gitRepoUrl} → ${config.workspaceDir}`);
  run(`git clone --depth 1 ${config.gitRepoUrl} ${config.workspaceDir}`, {
    label: `git clone → ${config.workspaceDir}`,
  });

  // Verify clone succeeded
  try {
    await fs.access(manifestPath);
    log.info('Clone successful — mindstudio.json found');
  } catch {
    log.warn('Clone completed but mindstudio.json not found');
    try {
      const files = await fs.readdir(config.workspaceDir);
      log.warn(`Workspace contents: ${files.join(', ')}`);
    } catch (e) {
      log.error(`Cannot list workspace: ${e}`);
    }
  }
}

export function configureGit(workspaceDir: string): void {
  run('git config user.name "MindStudio"', {
    cwd: workspaceDir,
    label: 'git config user.name',
  });
  run('git config user.email "noreply@mindstudio.ai"', {
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
  // Unshallow so remy can see full history for diffs and commits
  try {
    run('git fetch --unshallow', {
      cwd: workspaceDir,
      label: 'git fetch --unshallow',
    });
  } catch {
    log.info('git fetch --unshallow skipped (repo already has full history)');
  }
}

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
  for (const dir of installDirs) {
    run('npm install', { cwd: dir, label: `npm install in ${dir}` });
  }
  const elapsed = Date.now() - startTime;
  log.info(`All npm installs completed in ${elapsed}ms`);
}
