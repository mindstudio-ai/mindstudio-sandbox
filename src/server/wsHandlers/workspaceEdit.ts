/**
 * Multi-file disk-only replace.
 *
 * Sandbox handles edits on disk; the frontend owns dirty Monaco buffers
 * and applies them client-side (this handler never sees Monaco state).
 * Per-file: lock, stat, ifMatch staleness guard, binary reject, EOL
 * sniff + normalize, reverse-sort + overlap reject, apply edits in
 * memory, write through the suppressPath+writeFile+onFileChanged path
 * so the existing watcher/LSP/file-tree cascade runs unchanged. Errors
 * surface per-file; one bad file does not abort the batch.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { suppressPath } from '../../fileWatcher/index.ts';
import { resolveSafe } from '../../utils/paths.ts';
import { withFileLock } from '../../utils/fileLock.ts';
import { BINARY_EXTENSIONS } from './filesystem.ts';
import { ctx } from '../context.ts';
import { createLogger } from '../../logger.ts';

const log = createLogger('workspaceEdit');

const BINARY_SNIFF_BYTES = 8192;
const EOL_SNIFF_BYTES = 65536;

interface EditOp {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  newText: string;
}

interface FileEdit {
  path: string;
  ifMatch?: { mtime: number; size: number };
  edits: EditOp[];
}

interface ApplyParams {
  files: FileEdit[];
  dryRun?: boolean;
  preserveEol?: boolean;
}

type Status =
  | 'applied'
  | 'unchanged'
  | 'stale'
  | 'notFound'
  | 'binary'
  | 'overlap'
  | 'error'
  | 'dryRun';

interface FileResult {
  path: string;
  status: Status;
  error?: string;
  bytesBefore?: number;
  bytesAfter?: number;
  editsApplied?: number;
}

let workspaceDir = '';

export function initWorkspaceEdit(dir: string): void {
  workspaceDir = dir;
}

function sniffEol(content: string): '\n' | '\r\n' {
  const head = content.slice(0, EOL_SNIFF_BYTES);
  let crlf = 0;
  let lf = 0;
  for (let i = 0; i < head.length; i++) {
    if (head[i] === '\n') {
      if (i > 0 && head[i - 1] === '\r') {
        crlf++;
      } else {
        lf++;
      }
    }
  }
  return crlf > lf ? '\r\n' : '\n';
}

function normalizeEol(text: string, eol: '\n' | '\r\n'): string {
  return text.replace(/\r\n|\r|\n/g, eol);
}

/** Build per-line start offsets so we can convert {line,col} to char offset. */
function lineOffsets(content: string): number[] {
  const offsets = [0];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '\n') {
      offsets.push(i + 1);
    }
  }
  return offsets;
}

function posToOffset(offsets: number[], line: number, column: number): number {
  // 1-indexed line/col (Monaco convention).
  const lineIdx = Math.max(0, line - 1);
  if (lineIdx >= offsets.length) {
    // Past EOF — clamp to content length. Caller should validate, but
    // this prevents NaN-style explosions on edge edits.
    return offsets[offsets.length - 1] ?? 0;
  }
  return offsets[lineIdx] + Math.max(0, column - 1);
}

function isBinaryExt(filePath: string): boolean {
  return BINARY_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

async function sniffBinaryNul(absPath: string): Promise<boolean> {
  let fh: fs.FileHandle | undefined;
  try {
    fh = await fs.open(absPath, 'r');
    const buf = Buffer.alloc(BINARY_SNIFF_BYTES);
    const { bytesRead } = await fh.read(buf, 0, BINARY_SNIFF_BYTES, 0);
    for (let i = 0; i < bytesRead; i++) {
      if (buf[i] === 0) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  } finally {
    await fh?.close();
  }
}

async function applyToFile(
  fileEdit: FileEdit,
  opts: { dryRun: boolean; preserveEol: boolean },
): Promise<FileResult> {
  const { path: relPath, edits, ifMatch } = fileEdit;
  let absPath: string;
  try {
    absPath = resolveSafe(workspaceDir, relPath);
  } catch (err) {
    return {
      path: relPath,
      status: 'error',
      error: err instanceof Error ? err.message : 'invalid path',
    };
  }

  // Symlink defense: resolve realpath and verify it still lies inside
  // the workspace. Catches symlink-to-/etc/hosts style escapes that
  // resolveSafe alone won't detect because it only inspects the literal
  // path string.
  let realAbs: string;
  try {
    realAbs = await fs.realpath(absPath);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') {
      return { path: relPath, status: 'notFound' };
    }
    return {
      path: relPath,
      status: 'error',
      error: e.message,
    };
  }
  if (
    realAbs !== workspaceDir &&
    !realAbs.startsWith(workspaceDir + path.sep)
  ) {
    return {
      path: relPath,
      status: 'error',
      error: 'symlink escapes workspace',
    };
  }

  return withFileLock(realAbs, async () => {
    let stat: import('node:fs').Stats;
    try {
      stat = await fs.stat(realAbs);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') {
        return { path: relPath, status: 'notFound' as const };
      }
      return {
        path: relPath,
        status: 'error' as const,
        error: e.message,
      };
    }

    if (!stat.isFile()) {
      return {
        path: relPath,
        status: 'error' as const,
        error: 'not a regular file',
      };
    }

    if (isBinaryExt(relPath) || (await sniffBinaryNul(realAbs))) {
      return { path: relPath, status: 'binary' as const };
    }

    if (
      ifMatch &&
      (Math.abs(ifMatch.mtime - stat.mtimeMs) > 0.5 ||
        ifMatch.size !== stat.size)
    ) {
      return { path: relPath, status: 'stale' as const };
    }

    let content: string;
    try {
      content = await fs.readFile(realAbs, 'utf-8');
    } catch (err) {
      return {
        path: relPath,
        status: 'error' as const,
        error: err instanceof Error ? err.message : 'read failed',
      };
    }

    const eol = sniffEol(content);
    const offsets = lineOffsets(content);

    // Validate + convert edits to byte ranges. Ascending sort for
    // overlap detection; we apply in descending order so untouched
    // offsets stay valid.
    type ResolvedEdit = { start: number; end: number; newText: string };
    const resolved: ResolvedEdit[] = [];
    for (const e of edits) {
      if (
        typeof e.startLine !== 'number' ||
        typeof e.startColumn !== 'number' ||
        typeof e.endLine !== 'number' ||
        typeof e.endColumn !== 'number' ||
        typeof e.newText !== 'string'
      ) {
        return {
          path: relPath,
          status: 'error' as const,
          error: 'malformed edit',
        };
      }
      const start = posToOffset(offsets, e.startLine, e.startColumn);
      const end = posToOffset(offsets, e.endLine, e.endColumn);
      if (start > end) {
        return {
          path: relPath,
          status: 'error' as const,
          error: 'edit end precedes start',
        };
      }
      resolved.push({
        start,
        end,
        newText: opts.preserveEol ? normalizeEol(e.newText, eol) : e.newText,
      });
    }
    resolved.sort((a, b) => a.start - b.start);
    for (let i = 1; i < resolved.length; i++) {
      if (resolved[i].start < resolved[i - 1].end) {
        return { path: relPath, status: 'overlap' as const };
      }
    }

    // Apply in reverse so earlier offsets stay valid as we mutate.
    let next = content;
    for (let i = resolved.length - 1; i >= 0; i--) {
      const e = resolved[i];
      next = next.slice(0, e.start) + e.newText + next.slice(e.end);
    }

    if (next === content) {
      return {
        path: relPath,
        status: 'unchanged' as const,
        bytesBefore: Buffer.byteLength(content),
        bytesAfter: Buffer.byteLength(content),
        editsApplied: 0,
      };
    }

    if (opts.dryRun) {
      return {
        path: relPath,
        status: 'dryRun' as const,
        bytesBefore: Buffer.byteLength(content),
        bytesAfter: Buffer.byteLength(next),
        editsApplied: resolved.length,
      };
    }

    try {
      suppressPath(realAbs);
      await fs.writeFile(realAbs, next, 'utf-8');
    } catch (err) {
      return {
        path: relPath,
        status: 'error' as const,
        error: err instanceof Error ? err.message : 'write failed',
      };
    }

    // Re-broadcast as 'modified' (file already existed; changeType
    // 'created' that writeFile uses is a known white lie). Downstream
    // cascade (fileChanged broadcast, LSP refresh via lspSidecar,
    // file-tree update) is handled by ctx.onFileChanged.
    ctx.onFileChanged?.(relPath, 'modified');

    return {
      path: relPath,
      status: 'applied' as const,
      bytesBefore: Buffer.byteLength(content),
      bytesAfter: Buffer.byteLength(next),
      editsApplied: resolved.length,
    };
  });
}

export async function applyWorkspaceEdits(
  rawParams: Record<string, unknown>,
): Promise<{
  results: FileResult[];
  totalApplied: number;
  totalErrors: number;
}> {
  const params = rawParams as unknown as ApplyParams;
  if (!params.files || !Array.isArray(params.files)) {
    throw new Error('Missing "files" parameter');
  }

  const opts = {
    dryRun: params.dryRun === true,
    preserveEol: params.preserveEol !== false,
  };

  log.info(
    `applyWorkspaceEdits: ${params.files.length} file(s), dryRun=${opts.dryRun}`,
  );

  // Per-file work runs concurrently — each acquires its own lock.
  // Different files don't contend with each other.
  const results = await Promise.all(
    params.files.map((f) => applyToFile(f, opts)),
  );

  const totalApplied = results.filter((r) => r.status === 'applied').length;
  const totalErrors = results.filter(
    (r) =>
      r.status === 'error' ||
      r.status === 'stale' ||
      r.status === 'notFound' ||
      r.status === 'binary' ||
      r.status === 'overlap',
  ).length;

  // No snapshot trigger here: the snapshot manager walks home for changes on
  // its own interval (see HomeSnapshotManager).
  log.info(
    `applyWorkspaceEdits done: applied=${totalApplied}, errors=${totalErrors}`,
  );

  return { results, totalApplied, totalErrors };
}
