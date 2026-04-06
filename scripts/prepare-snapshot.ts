/**
 * prepare-snapshot — run inside the sandbox during snapshot builds.
 *
 * 1. Clones the empty app scaffold into the workspace directory
 * 2. Installs npm dependencies in all dist/ package dirs
 * 3. Pre-warms the npm cache with all scaffold dependencies
 *
 * After this script runs, the workspace is a fully set up scaffold with
 * node_modules installed. On boot, `cloneAppRepo` will fetch the user's
 * actual repo and reset to it — node_modules survives (gitignored) so
 * `npm install` is a near-instant no-op for scaffold-based projects.
 *
 * Usage: npx tsx scripts/prepare-snapshot.ts [workspaceDir]
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SCAFFOLD_REPO =
  'https://github.com/mindstudio-ai/empty-mindstudio-app-scaffold.git';

const workspaceDir = process.argv[2] || '/home/vercel-sandbox/workspace';

function run(cmd: string, opts?: { cwd?: string }) {
  console.log(`==> ${cmd}`);
  execSync(cmd, {
    cwd: opts?.cwd ?? workspaceDir,
    encoding: 'utf-8',
    stdio: 'inherit',
    timeout: 300_000,
  });
}

// ---------------------------------------------------------------------------
// 1. Clone scaffold into workspace
// ---------------------------------------------------------------------------

console.log(`\nPreparing snapshot (workspace: ${workspaceDir})\n`);

// If workspace already has content, clear it — snapshot build starts fresh
if (fs.existsSync(workspaceDir)) {
  fs.rmSync(workspaceDir, { recursive: true });
}

run(`git clone --depth 1 ${SCAFFOLD_REPO} ${workspaceDir}`, { cwd: '/tmp' });

// ---------------------------------------------------------------------------
// 2. Install dependencies in all dist/ package dirs
// ---------------------------------------------------------------------------

function findPackageDirs(baseDir: string): string[] {
  const dirs: string[] = [];
  const walk = (dir: string) => {
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        if (entry.name === 'package.json') dirs.push(dir);
      }
    } catch {
      // skip unreadable dirs
    }
  };
  walk(baseDir);
  return dirs;
}

const distDir = path.join(workspaceDir, 'dist');
const packageDirs = findPackageDirs(distDir);

console.log(`\nFound ${packageDirs.length} package dir(s) under dist/:`);
for (const dir of packageDirs) {
  console.log(`  ${path.relative(workspaceDir, dir)}`);
}

for (const dir of packageDirs) {
  run('npm install', { cwd: dir });
}

// ---------------------------------------------------------------------------
// 3. Pre-warm npm cache with all discovered dependencies
// ---------------------------------------------------------------------------

const allDeps = new Set<string>();
for (const dir of packageDirs) {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(dir, 'package.json'), 'utf-8'),
    );
    for (const name of Object.keys(pkg.dependencies ?? {})) allDeps.add(name);
    for (const name of Object.keys(pkg.devDependencies ?? {})) allDeps.add(name);
  } catch {
    // skip
  }
}

if (allDeps.size > 0) {
  console.log(`\nPre-warming npm cache with ${allDeps.size} packages`);
  run(`npm cache add ${[...allDeps].join(' ')}`);
} else {
  console.log('\nNo dependencies found, skipping cache warm');
}

// ---------------------------------------------------------------------------
// 4. Symlink mindstudio-prod CLI onto PATH
// ---------------------------------------------------------------------------

const cliSource = '/vercel/sandbox/dist/cli/prod.js';
const binDir = path.join(os.homedir(), '.local', 'bin');
const cliTarget = path.join(binDir, 'mindstudio-prod');

try {
  fs.chmodSync(cliSource, 0o755);
  fs.mkdirSync(binDir, { recursive: true });
  if (fs.existsSync(cliTarget)) fs.unlinkSync(cliTarget);
  fs.symlinkSync(cliSource, cliTarget);
  console.log(`\nSymlinked ${cliTarget} → ${cliSource}`);
} catch (err) {
  console.warn(`Warning: could not symlink CLI: ${err}`);
}

// ---------------------------------------------------------------------------
// Done
// ---------------------------------------------------------------------------

console.log('\nSnapshot preparation complete');
