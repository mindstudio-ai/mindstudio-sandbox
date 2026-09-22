/**
 * Build gate: the dev method worker must be a single self-contained file.
 *
 * `devTunnel/execution/executor.ts` copies the emitted worker into the USER's
 * project tree (node_modules/.cache/mindstudio-dev/ms-dev-worker-<hex>.mjs) and
 * forks it from there, so that its `import '@mindstudio-ai/agent'` resolves
 * against the app's own install rather than ours. Only that one file is copied.
 *
 * So a relative import inside it — a sibling module that was never copied —
 * fails at fork time with ERR_MODULE_NOT_FOUND, inside a container, on the
 * method-execution path, naming a path in somebody's app cache. No compiler
 * catches it: `worker.ts` importing a sibling is perfectly valid TypeScript.
 * Today it holds only because its single sibling import is `import type` and
 * therefore erases; `verbatimModuleSyntax` keeps that explicit in the source,
 * and this keeps it true in the output.
 *
 * If this fails: whatever you reached for in worker.ts needs to be inlined,
 * imported as a bare package specifier (resolved from the app's tree at fork
 * time), or made type-only.
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const WORKER = fileURLToPath(
  new URL('../dist/devTunnel/execution/worker.js', import.meta.url),
);

if (!existsSync(WORKER)) {
  console.error(
    `assert-worker-standalone: ${WORKER} does not exist.\n` +
      'Did the build emit it, or did the file move? The path is also hard-coded ' +
      'in devTunnel/execution/executor.ts (DEV_WORKER_DIST) — both must agree.',
  );
  process.exit(1);
}

const source = readFileSync(WORKER, 'utf-8');

// Static `from '…'`, bare `import '…'`, and dynamic `import('…')`.
const specifiers = [
  ...source.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g),
  ...source.matchAll(/\bimport\s*['"]([^'"]+)['"]/g),
  ...source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g),
].map((m) => m[1]);

const relative = specifiers.filter((s) => s.startsWith('.') || s.startsWith('/'));

if (relative.length > 0) {
  console.error(
    'assert-worker-standalone: the dev method worker is not self-contained.\n\n' +
      `  ${WORKER}\n\n` +
      'These specifiers point at files that are NOT copied alongside it, so a\n' +
      'method run would fail at fork time with ERR_MODULE_NOT_FOUND:\n\n' +
      relative.map((s) => `  - ${s}`).join('\n') +
      '\n\nInline it, use a bare package specifier, or make the import type-only.\n',
  );
  process.exit(1);
}

console.log(
  `assert-worker-standalone: ok — ${specifiers.length} specifiers, all bare.`,
);
