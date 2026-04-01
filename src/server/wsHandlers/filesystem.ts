import fs from 'node:fs/promises';
import path from 'node:path';
import { suppressPath } from '../../fileWatcher/index.js';
import { resolveSafe } from '../../utils/paths.js';

let workspaceDir: string;

export function initFilesystem(dir: string): void {
  workspaceDir = dir;
}

function safe(userPath: string): string {
  return resolveSafe(workspaceDir, userPath);
}

const BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.bmp',
  '.ico',
  '.webp',
  '.svg',
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
  '.otf',
  '.zip',
  '.tar',
  '.gz',
  '.bz2',
  '.7z',
  '.pdf',
  '.doc',
  '.docx',
  '.mp3',
  '.mp4',
  '.wav',
  '.ogg',
  '.webm',
  '.wasm',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
]);

function isBinary(filePath: string): boolean {
  return BINARY_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

export async function readFile(params: {
  path: string;
}): Promise<{ content: string; encoding: string }> {
  const filePath = safe(params.path);
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
  const filePath = safe(params.path);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  suppressPath(filePath);
  await fs.writeFile(filePath, params.content, 'utf-8');
  return {};
}

export async function deleteFile(params: {
  path: string;
}): Promise<Record<string, never>> {
  const filePath = safe(params.path);
  suppressPath(filePath);
  await fs.rm(filePath, { recursive: true });
  return {};
}

export async function renameFile(params: {
  oldPath: string;
  newPath: string;
}): Promise<Record<string, never>> {
  const oldFilePath = safe(params.oldPath);
  const newFilePath = safe(params.newPath);
  await fs.mkdir(path.dirname(newFilePath), { recursive: true });
  suppressPath(oldFilePath);
  suppressPath(newFilePath);
  await fs.rename(oldFilePath, newFilePath);
  return {};
}
