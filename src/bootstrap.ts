import { execSync, type ExecSyncOptions } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { Config } from './config.js';
import type { AppConfig, WebConfig } from './types.js';

type ProgressFn = (step: string, message: string) => void;

function run(
  cmd: string,
  opts?: ExecSyncOptions & { label?: string },
): string {
  const label = opts?.label ?? cmd;
  console.log(`[bootstrap] ${label}`);
  return execSync(cmd, {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 300000, // 5 minutes
    ...opts,
  }) as string;
}

export async function installTunnel(progress: ProgressFn): Promise<void> {
  // Check if already available
  try {
    execSync('which mindstudio-local', {
      encoding: 'utf-8',
      stdio: 'ignore',
    });
    console.log('[bootstrap] mindstudio-local already in PATH, skipping install');
    return;
  } catch {
    // Not found, install it
  }

  progress('installTunnel', 'Installing mindstudio-local tunnel...');
  run('npm install -g @mindstudio-ai/local-model-tunnel', {
    label: 'npm install -g @mindstudio-ai/local-model-tunnel',
  });
}

export async function writeTunnelConfig(config: Config): Promise<void> {
  const configDir = path.join(os.homedir(), '.mindstudio-local-tunnel');
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

  await fs.writeFile(
    path.join(configDir, 'config.json'),
    JSON.stringify(configData, null, 2),
    'utf-8',
  );
  console.log('[bootstrap] Wrote tunnel config');
}

export async function cloneAppRepo(
  config: Config,
  progress: ProgressFn,
): Promise<void> {
  // Skip if workspace already has a mindstudio.json
  try {
    await fs.access(path.join(config.workspaceDir, 'mindstudio.json'));
    console.log('[bootstrap] Workspace already has mindstudio.json, skipping clone');
    return;
  } catch {
    // File doesn't exist, proceed with clone
  }

  progress('cloneApp', `Cloning app repo...`);
  await fs.mkdir(config.workspaceDir, { recursive: true });
  run(`git clone --depth 1 ${config.gitRepoUrl} ${config.workspaceDir}`, {
    label: `git clone → ${config.workspaceDir}`,
  });
}

export async function readAppConfig(
  workspaceDir: string,
): Promise<AppConfig> {
  const raw = await fs.readFile(
    path.join(workspaceDir, 'mindstudio.json'),
    'utf-8',
  );
  return JSON.parse(raw) as AppConfig;
}

export async function readWebConfig(
  workspaceDir: string,
  appConfig: AppConfig,
): Promise<WebConfig | null> {
  const webInterface = appConfig.interfaces.find((i) => i.type === 'web');
  if (!webInterface) return null;

  const webJsonPath = path.join(workspaceDir, webInterface.path);
  try {
    const raw = await fs.readFile(webJsonPath, 'utf-8');
    return JSON.parse(raw) as WebConfig;
  } catch {
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

  // Filter to only dirs that have a package.json
  const installDirs: string[] = [];
  for (const dir of packageDirs) {
    try {
      await fs.access(path.join(dir, 'package.json'));
      installDirs.push(dir);
    } catch {
      // No package.json, skip
    }
  }

  if (installDirs.length === 0) {
    console.log('[bootstrap] No package.json files found, skipping install');
    return;
  }

  progress(
    'installDeps',
    `Installing dependencies in ${installDirs.length} directories...`,
  );

  // Run npm install in parallel
  await Promise.all(
    installDirs.map(
      (dir) =>
        new Promise<void>((resolve, reject) => {
          try {
            run('npm install', { cwd: dir, label: `npm install in ${dir}` });
            resolve();
          } catch (err) {
            reject(err);
          }
        }),
    ),
  );
}
