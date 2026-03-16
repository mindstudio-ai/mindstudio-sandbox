import { execSync, type ExecSyncOptions } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { Config } from './config.js';
import type { AppConfig, WebConfig } from './types.js';
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
        registry?.appendLog(procName, 'stdout', line);
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
        registry?.appendLog(procName, 'stderr', line);
      }
    }
    if (execErr.stdout) {
      for (const line of execErr.stdout.trim().split('\n')) {
        registry?.appendLog(procName, 'stdout', line);
      }
    }
    registry?.setState(procName, 'crashed', { exitCode: execErr.status ?? 1 });
    throw err;
  }
}

function verifyInstalled(binaryName: string): void {
  try {
    const result = execSync(`which ${binaryName}`, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    log.info(`${binaryName} installed at: ${result.trim()}`);
  } catch {
    log.warn(`${binaryName} not found after install`);
  }
}

export async function installTunnel(progress: ProgressFn): Promise<void> {
  // Clone, build, and link the tunnel from source.
  // npm install -g from git doesn't work because devDependencies (tsup, etc.)
  // aren't available. This is temporary — production will use the published npm package.
  const tunnelDir = '/tmp/mindstudio-local-tunnel';
  progress(
    'installTunnel',
    'Installing mindstudio-local tunnel from source...',
  );
  run(`rm -rf ${tunnelDir}`, { label: 'Clean tunnel dir' });
  run(
    `git clone --depth 1 --branch seant/appsv2 https://github.com/mindstudio-ai/mindstudio-local-model-tunnel.git ${tunnelDir}`,
    {
      label: 'git clone tunnel (seant/appsv2)',
    },
  );
  run('npm install', { cwd: tunnelDir, label: 'npm install in tunnel' });
  run('npm run build', { cwd: tunnelDir, label: 'npm run build in tunnel' });
  run(`npm install -g ${tunnelDir}`, {
    label: 'npm install -g (link built tunnel)',
  });

  verifyInstalled('mindstudio-local');
}

export async function installAgent(progress: ProgressFn): Promise<void> {
  // Clone, build, and link remy from source.
  // Temporary — production will use the published npm package.
  const agentDir = '/tmp/remy';
  progress('installAgent', 'Installing remy agent from source...');
  run(`rm -rf ${agentDir}`, { label: 'Clean agent dir' });
  run(
    `git clone --depth 1 https://github.com/mindstudio-ai/remy.git ${agentDir}`,
    { label: 'git clone remy' },
  );
  run('npm install', { cwd: agentDir, label: 'npm install in remy' });
  run('npm run build', { cwd: agentDir, label: 'npm run build in remy' });
  run(`npm install -g ${agentDir}`, {
    label: 'npm install -g (link built remy)',
  });

  verifyInstalled('remy');
}

export async function installLsp(progress: ProgressFn): Promise<void> {
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

export async function readAppConfig(workspaceDir: string): Promise<AppConfig> {
  const manifestPath = path.join(workspaceDir, 'mindstudio.json');
  log.debug(`Reading app config from ${manifestPath}`);

  const raw = await fs.readFile(manifestPath, 'utf-8');
  // Parse the full manifest — AppConfig is the typed subset but we
  // store the complete object so we can forward it to clients
  const config = JSON.parse(raw) as AppConfig;

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

  return config;
}

export async function readWebConfig(
  workspaceDir: string,
  appConfig: AppConfig,
): Promise<WebConfig | null> {
  const webInterface = appConfig.interfaces.find((i) => i.type === 'web');
  if (!webInterface) {
    log.info('No web interface defined in mindstudio.json');
    return null;
  }

  const webJsonPath = path.join(workspaceDir, webInterface.path);
  log.debug(`Reading web config from ${webJsonPath}`);

  try {
    const raw = await fs.readFile(webJsonPath, 'utf-8');
    const config = JSON.parse(raw) as WebConfig;
    log.debug(
      `Web config: devPort=${config.web?.devPort}, devCommand="${config.web?.devCommand}"`,
    );
    return config;
  } catch (err) {
    log.error(
      `Failed to read web config: ${err instanceof Error ? err.message : err}`,
    );
    return null;
  }
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
