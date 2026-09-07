import { exec } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Config } from '../config.js';
import type { AppConfig } from '../types.js';
import type { ProcessRegistry } from '../processes/ProcessRegistry.js';
import { createLogger } from '../logger.js';
import { bootPhase } from '../bootProgress.js';
import { loadJsonConfigFile } from '../utils/jsonConfig.js';
import {
  findGlobalPackage,
  HOME_GLOBAL_NODE_MODULES,
  IMAGE_GLOBAL_NODE_MODULES,
} from '../utils/globalPackages.js';
import {
  run,
  runAsync,
  isInstalled,
  verifyInstalled,
  globalTscMajor,
  installFromSource,
  setRegistry,
} from './helpers.js';

const log = createLogger('bootstrap');

type ProgressFn = (step: string, message: string) => void;

/**
 * Whether an installer had to do any work.
 *
 * `fromImage` is what the boot display's "cached" marker is made of, so it has to mean exactly
 * "nothing was installed": a dev-branch build or a corrective (down)grade is a slower boot for a
 * real reason, and reporting it as free would make the display lie about why boots differ.
 */
export interface ToolingInstall {
  fromImage: boolean;
}

export function setBootstrapRegistry(r: ProcessRegistry): void {
  setRegistry(r);
}

// ---------------------------------------------------------------------------
// Binary installers
// ---------------------------------------------------------------------------

export async function installTunnel(
  progress: ProgressFn,
): Promise<ToolingInstall> {
  const devBranch = process.env['TUNNEL_DEV_BRANCH'];

  if (!devBranch && isInstalled('mindstudio-local')) {
    progress('installTunnel', 'Already installed, skipping');
    log.info('mindstudio-local already installed, skipping');
    return { fromImage: true };
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
  return { fromImage: false };
}

export async function installAgent(
  progress: ProgressFn,
): Promise<ToolingInstall> {
  const devBranch = process.env['AGENT_DEV_BRANCH'];

  if (!devBranch && isInstalled('remy')) {
    progress('installAgent', 'Already installed, skipping');
    log.info('remy already installed, skipping');
    return { fromImage: true };
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
  return { fromImage: false };
}

export async function installAgentSdk(progress: ProgressFn): Promise<void> {
  const devBranch = process.env['AGENT_SDK_DEV_BRANCH'];

  // The GLOBAL agent SDK is PLATFORM tooling, not a project dependency: remy shells out to it as a
  // bash tool. The version the user's app depends on is its own — `dist/methods/package.json` in
  // their repo, theirs and the agent's to manage — and is untouched by any of this. So this copy
  // must always be the image's, which is what makes `--allow-scripts` and a tested postinstall in
  // Dockerfile.devbox meaningful.
  //
  // Nothing to install, then: the image already baked it into /usr/local. The job here is the
  // opposite one. `NPM_CONFIG_PREFIX` points at ~/.npm-global, which rides INSIDE the home
  // snapshot and comes FIRST on PATH — so a copy there shadows the image's for the life of the app.
  // The old presence check used `npm list -g`, which only sees that runtime prefix, so it reinstalled
  // on every boot and every snapshot since has frozen a copy there. Evicting it is both the fix and
  // the cleanup for the snapshots already written.
  //
  // `npm uninstall -g` rather than an rm: it clears the bin symlinks too, and a dangling link first
  // on PATH is worse than the shadow. Costs ~1s once per app, then the directory is gone and this
  // step is free forever.
  if (!devBranch) {
    const shadow = findGlobalPackage('@mindstudio-ai/agent', [
      HOME_GLOBAL_NODE_MODULES,
    ]);
    if (shadow) {
      progress('installAgentSdk', 'Removing stale local copy...');
      log.info(
        `agent SDK ${shadow.version} found in the home prefix, shadowing the image's — removing`,
      );
      run('npm uninstall -g @mindstudio-ai/agent', {
        label: 'npm uninstall -g @mindstudio-ai/agent',
      });
    }

    const baked = findGlobalPackage('@mindstudio-ai/agent', [
      IMAGE_GLOBAL_NODE_MODULES,
    ]);
    if (baked) {
      progress('installAgentSdk', 'Using image version, skipping');
      log.info(`agent SDK ${baked.version} from image, skipping install`);
      return;
    }
    // Only reachable on an image predating the baked install. Falls through and installs.
    log.warn('agent SDK not baked into this image; installing at boot');
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

// Pinned to the CLASSIC TypeScript line. Do NOT unpin or bump to TS 7+:
// TypeScript 7 is the native (Go) rewrite that removed `lib/tsserver.js`, the
// JS server `typescript-language-server` spawns — an unpinned install floated
// into 7.0 and bricked LSP boot. When we migrate to the native server
// (`tsgo --lsp` from `@typescript/native-preview`), this whole function changes;
// until then, stay on 6.x. `typescript@6.0.3` is the latest 6.x (still ships
// `lib/tsserver.js`); `typescript-language-server@5.3.0` is its latest.
const PINNED_LSP_SERVER = 'typescript-language-server@5.3.0';
const PINNED_TYPESCRIPT = 'typescript@6.0.3';
const CLASSIC_TS_MAJOR = 6;

export async function installLsp(
  progress: ProgressFn,
): Promise<ToolingInstall> {
  // Skip only when the language server is present AND the global TypeScript is
  // on the classic (6.x) line. A bare "is `tsc` present?" check isn't enough: a
  // warm/pre-baked environment may already carry a floated `typescript@7` (which
  // still ships `bin/tsc`), and skipping there would strand us on the broken 7.0.
  // Version-gating forces a corrective (down)grade to the pinned classic build.
  if (
    isInstalled('typescript-language-server') &&
    globalTscMajor() === CLASSIC_TS_MAJOR
  ) {
    progress('installLsp', 'Already installed, skipping');
    log.info(
      `typescript-language-server + typescript@${CLASSIC_TS_MAJOR}.x already installed, skipping`,
    );
    return { fromImage: true };
  }

  progress('installLsp', 'Installing TypeScript language server...');
  run(`npm install -g ${PINNED_LSP_SERVER} ${PINNED_TYPESCRIPT}`, {
    label: `npm install -g ${PINNED_LSP_SERVER} ${PINNED_TYPESCRIPT}`,
  });

  verifyInstalled('typescript-language-server');
  verifyInstalled('tsc');
  return { fromImage: false };
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

/** Clone the app's repo into an empty workspace (an app with no snapshot yet). */
export async function cloneAppRepo(
  config: Config,
  progress: ProgressFn,
): Promise<void> {
  const { workspaceDir, gitRepoUrl } = config;

  progress('cloneApp', 'Cloning app repo...');
  log.debug(`Creating workspace dir: ${workspaceDir}`);
  await fs.mkdir(workspaceDir, { recursive: true });

  // NOT `git clone <url> <workspaceDir>`, which is what this was: the image now ships this app's
  // node_modules already installed at their final paths inside the workspace (Dockerfile.devbox),
  // and clone refuses a non-empty destination.
  //
  // So clone the METADATA to a scratch directory, move the `.git` into the workspace, and let git
  // materialise the tree in place. `--no-checkout` is what makes the move cheap — nothing but `.git`
  // is written, so it is one directory rename rather than a tree copy.
  //
  // The scratch directory has to sit under $HOME and not /tmp. Both are inside the container, but a
  // tmpfs `/tmp` would put the two on different filesystems and turn the rename back into the
  // recursive copy this whole arrangement exists to avoid.
  //
  // Then `git reset --hard`, which writes the tracked tree and leaves untracked files alone —
  // node_modules is gitignored in the scaffold and in every real app, so the baked trees survive.
  // Doing it this way keeps git's own clone semantics: a local branch tracking origin's default,
  // shallow state intact. `refreshGitRemote`, `unshallowAsync` and the agent's own commits all
  // assume a normal checkout, and a detached HEAD would break pushing without failing here.
  const scratchDir = path.join(config.homeDir, '.app-clone');
  await fs.rm(scratchDir, { recursive: true, force: true });
  log.info(`Cloning ${gitRepoUrl} → ${workspaceDir}`);
  run(`git clone --depth 1 --no-checkout ${gitRepoUrl} ${scratchDir}`, {
    label: 'git clone (metadata only)',
  });
  // `-T`: treat the destination as the thing to become, not a directory to move into. Without it a
  // pre-existing `.git` in the workspace would silently become `.git/.git` and the reset below would
  // fail somewhere less obvious. Nothing should put one there — this path runs only when there was
  // no snapshot to restore, and the image ships no repo — so the right behaviour is to fail loudly
  // if that assumption ever stops holding.
  run(
    `mv -T ${path.join(scratchDir, '.git')} ${path.join(workspaceDir, '.git')}`,
    { label: 'git dir → workspace' },
  );
  await fs.rm(scratchDir, { recursive: true, force: true });
  run('git reset --hard HEAD', {
    cwd: workspaceDir,
    label: 'git reset --hard (materialise tree)',
  });

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

/**
 * Point a restored workspace's `origin` at this session's repo URL and refresh
 * it in the background. The URL embeds a per-session git token and the platform
 * revokes the previous one at each start, so the credential inside a restored
 * `.git/config` is always dead. Best-effort: a workspace without `.git` (the
 * user removed it) is left alone.
 */
export function refreshGitRemote(config: Config): void {
  const { workspaceDir, gitRepoUrl } = config;
  if (!fsSync.existsSync(path.join(workspaceDir, '.git'))) {
    log.warn('Restored workspace has no .git; leaving git alone');
    return;
  }
  run(`git remote set-url origin ${gitRepoUrl}`, {
    cwd: workspaceDir,
    label: 'git remote set-url',
  });
  const start = Date.now();
  exec(
    'git fetch origin',
    { cwd: workspaceDir, encoding: 'utf-8', timeout: 120_000 },
    (err) => {
      const elapsed = Date.now() - start;
      if (err) {
        log.warn(`git fetch origin failed in ${elapsed}ms: ${err.message}`);
      } else {
        log.info(`git fetch origin completed in ${elapsed}ms`);
      }
    },
  );
}

/**
 * Deepen a fresh shallow clone in the background so remy can later see full
 * history for diffs and commits. Fire-and-forget — nothing in boot needs deep
 * history, and remy only needs it when the user first asks for a diff/commit.
 *
 * MUST be kicked off AFTER the legacy `_draft` fetch completes: `git fetch
 * --unshallow` and that `git fetch --depth=1` both mutate `.git/shallow` and
 * contend on `.git/shallow.lock`. Running them concurrently makes whichever
 * loses the race die with "Unable to create '.git/shallow.lock': File exists."
 */
export function unshallowAsync(workspaceDir: string): void {
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

/**
 * Ensure the remy-admin CLI (@madewithremy/admin) is on PATH.
 *
 * Snapshot builds install it (scripts/prepare-snapshot.ts, section 4), so a
 * snapshot boot skips straight through; this is the self-heal for a boot that
 * didn't come from a prepared snapshot. Best-effort: a registry blip degrades
 * to a warning rather than failing the boot, matching the old symlink
 * self-heal — the CLI is the agent's tooling, not a boot dependency.
 */
export function ensureProdCli(): void {
  if (isInstalled('remy-admin')) {
    log.info('remy-admin already installed, skipping');
    return;
  }
  try {
    run('npm install -g @madewithremy/admin', {
      label: 'npm install -g @madewithremy/admin',
    });
    verifyInstalled('remy-admin');
  } catch (err) {
    log.warn(`Failed to install remy-admin CLI: ${err}`);
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

  // Parse the full manifest — AppConfig is the typed subset but we
  // store the complete object so we can forward it to clients.
  //
  // Tolerant + self-repairing: a trailing comma from an agent edit is
  // rescued by JSON5 and the file is rewritten as strict JSON. The repair
  // happens inside this call, i.e. BEFORE the interface-resolution loop
  // below mutates `iface.config` — writing after that point would persist
  // the resolved interface blobs back into mindstudio.json.
  const result = await loadJsonConfigFile<AppConfig>(manifestPath, {
    normalize: true,
  });
  if (!result.ok) {
    if (result.notFound) {
      log.error(`App config not found at ${manifestPath}`);
    } else {
      log.error(`Failed to parse app config: ${result.error}`);
    }
    return null;
  }
  const config = result.value;

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
    // An entry with no path has no file to resolve — either its config is inline
    // under `config` (already carried by the parsed manifest, so leaving it
    // untouched is correct), or the type has nothing to configure at all.
    // Skipping matches the pipeline this loop mirrors, which logs and continues.
    //
    // This was fatal rather than cosmetic: `path.join(dir, undefined)` throws,
    // and the throw escapes readAppConfig's null-return contract into main()'s
    // catch, so one absent optional field on one interface took the whole
    // sandbox down at bootstrap instead of reaching the degraded mode the caller
    // already handles. The not-found branch below has always tolerated the file
    // being absent; only the field itself was unguarded.
    if (!iface.path) {
      log.debug(`  ${iface.type} declares no config path — nothing to resolve`);
      continue;
    }
    const configPath = path.join(workspaceDir, iface.path);
    const ifaceResult = await loadJsonConfigFile<Record<string, unknown>>(
      configPath,
      { normalize: true },
    );
    if (!ifaceResult.ok) {
      if (ifaceResult.notFound) {
        log.debug(`  ${iface.type} config not found at ${iface.path}`);
      } else {
        // Previously silent: an unparseable web.json fell through to the
        // default devCommand/devPort, which can silently point the tunnel at
        // the wrong port.
        log.warn(
          `  ${iface.type} config at ${iface.path} is unparseable: ${ifaceResult.error}`,
        );
      }
      continue;
    }
    const inner = ifaceResult.value[iface.type];
    if (inner && typeof inner === 'object') {
      iface.config = inner as Record<string, unknown>;
      log.debug(`  ${iface.type} config resolved from ${iface.path}`);
    }
  }

  return config;
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface InstallFailure {
  dir: string;
  error: string;
}

export interface InstallResult {
  failures: InstallFailure[];
  /** How many package directories were found and installed, for the boot display. */
  installedDirs: number;
}

/**
 * npm's own account of what it had to do, kept as telemetry.
 *
 * `added N, removed N, changed N` measures how much of the tree was already satisfied before the
 * install ran — by the image's baked copy, or by a restored snapshot from an older box. A boot that
 * adds almost nothing found a near-exact match; one that adds hundreds says the baked manifest has
 * drifted from what real apps resolve to. That is the input for revising the manifest, and npm
 * prints it for nothing.
 */
function logInstallSummary(dir: string, stdout: string): void {
  const summary = stdout
    .split('\n')
    .map((l) => l.trim())
    .find((l) => /^(added|removed|changed|up to date)/.test(l));
  log.info(`deps ${path.basename(dir)}: ${summary ?? 'no npm summary line'}`);
}

/**
 * Run `npm install` in one directory. On ERESOLVE-style failures, retry
 * once with `--legacy-peer-deps`. App package.jsons in the wild often have
 * peer-dep skew (e.g. vite vs. vite-plugin-pwa) — the retry recovers most
 * of those without user intervention. If both attempts fail, return the
 * error rather than throwing so the caller can keep bootstrapping.
 */
async function npmInstallWithFallback(
  dir: string,
): Promise<InstallFailure | null> {
  try {
    const out = await runAsync('npm install', {
      cwd: dir,
      label: `npm install in ${dir}`,
    });
    logInstallSummary(dir, out);
    return null;
  } catch (err) {
    const firstError = err instanceof Error ? err.message : String(err);
    log.warn(
      `Strict npm install failed in ${dir}, retrying with --legacy-peer-deps`,
    );
    try {
      const out = await runAsync('npm install --legacy-peer-deps', {
        cwd: dir,
        label: `npm install --legacy-peer-deps in ${dir}`,
      });
      logInstallSummary(dir, out);
      return null;
    } catch (retryErr) {
      const retryError =
        retryErr instanceof Error ? retryErr.message : String(retryErr);
      // Surface the retry error since it's the more relevant signal —
      // the strict failure is implied.
      log.error(`npm install failed even with --legacy-peer-deps in ${dir}`);
      return { dir, error: retryError || firstError };
    }
  }
}

/**
 * The directories in this app that have npm dependencies of their own.
 *
 * Every interface, not just `web`. A Remy app has one methods directory and N interfaces, and today
 * only `web` ships JavaScript — the rest (api, cron, email, webhook, agent) are json/md driven and
 * carry no package.json, so they fall out here at no cost. Naming `web` explicitly, as this used to,
 * would just be wrong on the day a second interface serves JS.
 *
 * Has to agree with the set Dockerfile.devbox bakes trees into, or a tree lands in a directory
 * nothing installs in.
 */
async function findPackageDirs(workspaceDir: string): Promise<string[]> {
  const interfacesDir = path.join(workspaceDir, 'dist', 'interfaces');
  const interfaceNames = await fs.readdir(interfacesDir).catch(() => []);
  const candidates = [
    path.join(workspaceDir, 'dist', 'methods'),
    ...interfaceNames.map((name) => path.join(interfacesDir, name)),
  ];

  const found: string[] = [];
  for (const dir of candidates) {
    const pkgPath = path.join(dir, 'package.json');
    try {
      await fs.access(pkgPath);
      log.debug(`  Found: ${pkgPath}`);
      found.push(dir);
    } catch {
      log.debug(`  Not found: ${pkgPath}`);
    }
  }
  return found;
}

/**
 * How many packages this directory's lockfile resolves to, or 0 when we cannot tell.
 *
 * Only used to weight the progress bar across directories, so it wants to be roughly proportional
 * and never to throw — a missing, unparsable or lockfile-less app just gets an unweighted bar, which
 * is what it had before. Counting `packages` keys rather than the dependency tree because that map
 * IS the resolved set, one entry per installed package, which is the closest thing to "how much work
 * is this" available before npm starts.
 */
async function lockfilePackageCount(dir: string): Promise<number> {
  try {
    const raw = await fs.readFile(path.join(dir, 'package-lock.json'), 'utf-8');
    const packages = JSON.parse(raw)?.packages;
    return packages && typeof packages === 'object'
      ? Object.keys(packages).length
      : 0;
  } catch {
    return 0;
  }
}

export async function installDependencies(
  workspaceDir: string,
  progress: ProgressFn,
): Promise<InstallResult> {
  log.debug('Scanning for package.json files...');
  const installDirs = await findPackageDirs(workspaceDir);

  if (installDirs.length === 0) {
    log.info('No package.json files found, skipping install');
    return { failures: [], installedDirs: 0 };
  }

  progress(
    'installDeps',
    `Installing dependencies in ${installDirs.length} directories...`,
  );

  const startTime = Date.now();

  // This is the phase most of a boot now sits in, and npm prints no incremental progress of its own,
  // so without this the longest row on screen was a ticking timer over an empty subtitle for 30s.
  // Directories finished out of directories found is the only measure honestly available; both ends
  // are observed, and the label names whichever are still running so the line changes as well as
  // the bar.
  //
  // Emitted BEFORE the installs start, not just as each lands. Without the opening `0 of N` the row
  // has nothing at all until the first directory finishes, which on a two-directory app is most of
  // the phase.
  //
  // The BAR is weighted by each directory's package count while the text keeps counting
  // directories, because the two directories are nowhere near the same size — a real app measured
  // 111 packages in `methods` against 648 in `interfaces/web`. Unweighted, finishing methods jumped
  // the bar to 50% when it was a seventh of the work.
  const weights = await Promise.all(installDirs.map(lockfilePackageCount));
  const totalWeight = weights.reduce((sum, n) => sum + n, 0);
  const doneDirs = new Set<string>();
  const remaining = new Set(installDirs.map((dir) => path.basename(dir)));
  const emit = (done: number) => {
    const names = [...remaining].join(', ');
    // Falls back to the plain ratio when no lockfile could be read, which is the behaviour before
    // this existed — an app without lockfiles is no worse off than it was.
    const fraction =
      totalWeight > 0
        ? installDirs.reduce(
            (sum, dir, i) => (doneDirs.has(dir) ? sum + weights[i] : sum),
            0,
          ) / totalWeight
        : undefined;
    bootPhase(
      names ? `Installing dependencies · ${names}` : 'Dependencies installed',
      {
        phase: 'deps',
        state: 'active',
        counter: {
          done,
          total: installDirs.length,
          unit: 'dirs',
          label: names ? `Installing ${names}` : 'Installed',
          ...(fraction === undefined ? {} : { fraction }),
        },
      },
    );
  };
  emit(0);

  let done = 0;
  const results = await Promise.all(
    installDirs.map((dir) =>
      npmInstallWithFallback(dir).finally(() => {
        done += 1;
        doneDirs.add(dir);
        remaining.delete(path.basename(dir));
        emit(done);
      }),
    ),
  );
  const elapsed = Date.now() - startTime;
  const failures = results.filter((r): r is InstallFailure => r !== null);
  if (failures.length === 0) {
    log.info(`All npm installs completed in ${elapsed}ms`);
  } else {
    log.warn(
      `npm install completed in ${elapsed}ms with ${failures.length} failure(s)`,
    );
  }
  return { failures, installedDirs: installDirs.length };
}
