import fs from 'node:fs/promises';
import path from 'node:path';
import type { DirEntry, TreeEntry } from '../types.js';
import { suppressPath } from '../file-watcher.js';

let workspaceDir: string;

export function initFilesystem(dir: string): void {
  workspaceDir = dir;
}

function resolveSafe(userPath: string): string {
  const resolved = path.resolve(workspaceDir, userPath);
  if (resolved !== workspaceDir && !resolved.startsWith(workspaceDir + '/')) {
    throw new Error('Path escapes workspace');
  }
  return resolved;
}

function relativePath(absPath: string): string {
  return path.relative(workspaceDir, absPath);
}

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.svg',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.zip', '.tar', '.gz', '.bz2', '.7z',
  '.pdf', '.doc', '.docx',
  '.mp3', '.mp4', '.wav', '.ogg', '.webm',
  '.wasm', '.exe', '.dll', '.so', '.dylib',
]);

function isBinary(filePath: string): boolean {
  return BINARY_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

export async function listDir(params: {
  path: string;
}): Promise<{ entries: DirEntry[] }> {
  const dirPath = resolveSafe(params.path);
  const entries = await fs.readdir(dirPath, { withFileTypes: true });

  const results: DirEntry[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    try {
      const stat = await fs.stat(fullPath);
      results.push({
        name: entry.name,
        type: entry.isDirectory() ? 'directory' : 'file',
        size: stat.size,
        modified: stat.mtime.toISOString(),
      });
    } catch {
      // Skip entries we can't stat (broken symlinks, etc.)
    }
  }

  return { entries: results };
}

export async function readFile(params: {
  path: string;
}): Promise<{ content: string; encoding: string }> {
  const filePath = resolveSafe(params.path);
  if (isBinary(filePath)) {
    const buf = await fs.readFile(filePath);
    return { content: buf.toString('base64'), encoding: 'base64' };
  }
  const content = await fs.readFile(filePath, 'utf-8');
  return { content, encoding: 'utf-8' };
}

export async function writeFile(params: {
  path: string;
  content: string;
}): Promise<Record<string, never>> {
  const filePath = resolveSafe(params.path);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  suppressPath(filePath);
  await fs.writeFile(filePath, params.content, 'utf-8');
  return {};
}

export async function deleteFile(params: {
  path: string;
}): Promise<Record<string, never>> {
  const filePath = resolveSafe(params.path);
  suppressPath(filePath);
  await fs.rm(filePath, { recursive: true });
  return {};
}

export async function renameFile(params: {
  oldPath: string;
  newPath: string;
}): Promise<Record<string, never>> {
  const oldFilePath = resolveSafe(params.oldPath);
  const newFilePath = resolveSafe(params.newPath);
  await fs.mkdir(path.dirname(newFilePath), { recursive: true });
  suppressPath(oldFilePath);
  suppressPath(newFilePath);
  await fs.rename(oldFilePath, newFilePath);
  return {};
}

const TREE_IGNORE = new Set(['node_modules', '.git', '.vite']);

/**
 * Build a recursive file tree up to `depth` levels deep.
 * Directories beyond the depth limit are included but without children.
 */
export async function buildTree(
  dirPath: string = workspaceDir,
  relativeTo: string = workspaceDir,
  depth: number = 3,
): Promise<TreeEntry[]> {
  let entries;
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }

  const results: TreeEntry[] = [];

  for (const entry of entries) {
    if (TREE_IGNORE.has(entry.name)) continue;

    const fullPath = path.join(dirPath, entry.name);
    const relPath = path.relative(relativeTo, fullPath);

    try {
      const stat = await fs.stat(fullPath);
      const node: TreeEntry = {
        name: entry.name,
        path: relPath,
        type: entry.isDirectory() ? 'directory' : 'file',
        size: stat.size,
        modified: stat.mtime.toISOString(),
      };

      if (entry.isDirectory() && depth > 1) {
        node.children = await buildTree(fullPath, relativeTo, depth - 1);
      }

      results.push(node);
    } catch {
      // Skip entries we can't stat
    }
  }

  // Sort: directories first, then alphabetical
  results.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return results;
}
