import { execSync, type ExecSyncOptions } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { Config } from './config.js';
import type { AppConfig, WebConfig } from './types.js';

type ProgressFn = (step: string, message: string) => void;

function run(cmd: string, opts?: ExecSyncOptions & { label?: string }): string {
  const label = opts?.label ?? cmd;
  console.log(`[bootstrap] Running: ${label}`);
  const startTime = Date.now();
  try {
    const result = execSync(cmd, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 300000, // 5 minutes
      ...opts,
    }) as string;
    const elapsed = Date.now() - startTime;
    console.log(`[bootstrap] Completed in ${elapsed}ms: ${label}`);
    if (result.trim()) {
      // Log first few lines of output for visibility
      const lines = result.trim().split('\n');
      const preview = lines.slice(0, 5).join('\n');
      console.log(
        `[bootstrap] Output (${lines.length} lines):\n${preview}${lines.length > 5 ? '\n  ...' : ''}`,
      );
    }
    return result;
  } catch (err: unknown) {
    const elapsed = Date.now() - startTime;
    const execErr = err as {
      stderr?: string;
      stdout?: string;
      status?: number;
      message?: string;
    };
    console.error(`[bootstrap] FAILED after ${elapsed}ms: ${label}`);
    console.error(`[bootstrap]   Exit code: ${execErr.status}`);
    if (execErr.stderr) {
      console.error(
        `[bootstrap]   stderr: ${execErr.stderr.trim().slice(0, 2000)}`,
      );
    }
    if (execErr.stdout) {
      console.error(
        `[bootstrap]   stdout: ${execErr.stdout.trim().slice(0, 2000)}`,
      );
    }
    throw err;
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

  // Verify it installed
  try {
    const whichResult = execSync('which mindstudio-local', {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    console.log(`[bootstrap] Tunnel installed at: ${whichResult.trim()}`);
  } catch {
    console.error(
      '[bootstrap] WARNING: mindstudio-local not found after install',
    );
  }
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

  // Verify
  try {
    const whichResult = execSync('which remy', {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    console.log(`[bootstrap] Remy installed at: ${whichResult.trim()}`);
  } catch {
    console.error('[bootstrap] WARNING: remy not found after install');
  }
}

export async function writeTunnelConfig(config: Config): Promise<void> {
  const configDir = path.join(os.homedir(), '.mindstudio-local-tunnel');
  const configPath = path.join(configDir, 'config.json');
  console.log(`[bootstrap] Writing tunnel config to ${configPath}`);

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
  console.log(
    `[bootstrap] Tunnel config written (apiBaseUrl=${config.apiBaseUrl}, userId=${config.userId})`,
  );
}

export async function cloneAppRepo(
  config: Config,
  progress: ProgressFn,
): Promise<void> {
  const manifestPath = path.join(config.workspaceDir, 'mindstudio.json');
  console.log(`[bootstrap] Checking for ${manifestPath}...`);

  // Skip if workspace already has a mindstudio.json
  try {
    await fs.access(manifestPath);
    console.log('[bootstrap] mindstudio.json exists, skipping clone');
    return;
  } catch {
    console.log('[bootstrap] mindstudio.json not found, will clone');
  }

  progress('cloneApp', `Cloning app repo...`);
  console.log(`[bootstrap] Creating workspace dir: ${config.workspaceDir}`);
  await fs.mkdir(config.workspaceDir, { recursive: true });
  console.log(
    `[bootstrap] Cloning ${config.gitRepoUrl} → ${config.workspaceDir}`,
  );
  run(`git clone --depth 1 ${config.gitRepoUrl} ${config.workspaceDir}`, {
    label: `git clone → ${config.workspaceDir}`,
  });

  // Verify clone succeeded
  try {
    await fs.access(manifestPath);
    console.log('[bootstrap] Clone successful — mindstudio.json found');
  } catch {
    console.error(
      '[bootstrap] WARNING: Clone completed but mindstudio.json not found',
    );
    // List what we got
    try {
      const files = await fs.readdir(config.workspaceDir);
      console.log(`[bootstrap] Workspace contents: ${files.join(', ')}`);
    } catch (e) {
      console.error(`[bootstrap] Cannot list workspace: ${e}`);
    }
  }
}

export async function readAppConfig(workspaceDir: string): Promise<AppConfig> {
  const manifestPath = path.join(workspaceDir, 'mindstudio.json');
  console.log(`[bootstrap] Reading app config from ${manifestPath}`);

  const raw = await fs.readFile(manifestPath, 'utf-8');
  const config = JSON.parse(raw) as AppConfig;

  console.log(`[bootstrap] App: "${config.name}" (${config.appId})`);
  console.log(
    `[bootstrap]   Methods: ${config.methods?.length ?? 0} (${config.methods?.map((m) => m.id).join(', ') || 'none'})`,
  );
  console.log(
    `[bootstrap]   Tables: ${config.tables?.length ?? 0} (${config.tables?.map((t) => t.export).join(', ') || 'none'})`,
  );
  console.log(
    `[bootstrap]   Interfaces: ${config.interfaces?.length ?? 0} (${config.interfaces?.map((i) => i.type).join(', ') || 'none'})`,
  );

  return config;
}

export async function readWebConfig(
  workspaceDir: string,
  appConfig: AppConfig,
): Promise<WebConfig | null> {
  const webInterface = appConfig.interfaces.find((i) => i.type === 'web');
  if (!webInterface) {
    console.log('[bootstrap] No web interface defined in mindstudio.json');
    return null;
  }

  const webJsonPath = path.join(workspaceDir, webInterface.path);
  console.log(`[bootstrap] Reading web config from ${webJsonPath}`);

  try {
    const raw = await fs.readFile(webJsonPath, 'utf-8');
    const config = JSON.parse(raw) as WebConfig;
    console.log(
      `[bootstrap] Web config: devPort=${config.web?.devPort}, devCommand="${config.web?.devCommand}"`,
    );
    return config;
  } catch (err) {
    console.error(
      `[bootstrap] Failed to read web config: ${err instanceof Error ? err.message : err}`,
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

  console.log('[bootstrap] Scanning for package.json files...');

  // Filter to only dirs that have a package.json
  const installDirs: string[] = [];
  for (const dir of packageDirs) {
    const pkgPath = path.join(dir, 'package.json');
    try {
      await fs.access(pkgPath);
      console.log(`[bootstrap]   Found: ${pkgPath}`);
      installDirs.push(dir);
    } catch {
      console.log(`[bootstrap]   Not found: ${pkgPath}`);
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
  const startTime = Date.now();
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
  const elapsed = Date.now() - startTime;
  console.log(`[bootstrap] All npm installs completed in ${elapsed}ms`);
}
