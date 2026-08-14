import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { type Args, type CommandSpec, type FlagSpec } from '../args.js';
import { api } from '../api.js';
import { WORKSPACE_DIR } from '../config.js';
import { EXIT, fatal } from '../errors.js';
import { out, progress } from '../output.js';
import { sleep } from '../sleep.js';
import type { Handler } from '../types.js';

const DEFAULT_SOURCE = 'default';
const POLL_MS = 3000;
const DEFAULT_WAIT_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * Pipeline settings, shared by `config` and `revectorize` so the two can never
 * disagree about what's tunable.
 *
 * Booleans are strings rather than flags because they're TRI-STATE here:
 * "leave alone" has to be distinguishable from "turn off", and a bare
 * `--contextual` can only ever mean true.
 */
const CONFIG_FLAGS = {
  // Pinned — changing any of these needs a re-vectorize.
  'max-chars': { type: 'number', min: 200 },
  'min-chars': { type: 'number', min: 0 },
  'drop-blocks': { type: 'string' },
  contextual: { type: 'string' },
  'describe-images': { type: 'string' },
  'embedding-model': { type: 'string' },
  'image-model': { type: 'string' },
  'extraction-model': { type: 'string' },
  // Live — take effect on the next search, no rebuild.
  rerank: { type: 'string' },
  hybrid: { type: 'string' },
  'top-k': { type: 'number', min: 1 },
} as const satisfies Record<string, FlagSpec>;

export const dataSourcesSpecs = {
  'datasources add': {
    usage:
      'Usage: mindstudio-prod datasources add [--source <slug>] [--wait] [--timeout <sec>] <file...>',
    positionals: [{ name: 'file', required: true, variadic: true }],
    flags: {
      source: { type: 'string' },
      wait: { type: 'boolean' },
      timeout: { type: 'string' },
    },
  },
  'datasources list': {
    usage: 'Usage: mindstudio-prod datasources list',
  },
  'datasources status': {
    usage: 'Usage: mindstudio-prod datasources status [--source <slug>]',
    flags: { source: { type: 'string' } },
  },
  'datasources rm': {
    usage:
      'Usage: mindstudio-prod datasources rm [--source <slug>] --document <id>',
    flags: { source: { type: 'string' }, document: { type: 'string' } },
  },
  'datasources search': {
    usage:
      'Usage: mindstudio-prod datasources search [--source <slug>] [--top-k <n>] [--candidate] <query>',
    positionals: [{ name: 'query', required: true }],
    flags: {
      source: { type: 'string' },
      'top-k': { type: 'string' },
      candidate: { type: 'boolean' },
      rerank: { type: 'string' },
      hybrid: { type: 'string' },
    },
  },
  'datasources config': {
    usage:
      'Usage: mindstudio-prod datasources config [--source <slug>] [settings...]',
    flags: { source: { type: 'string' }, ...CONFIG_FLAGS },
  },
  'datasources revectorize': {
    usage:
      'Usage: mindstudio-prod datasources revectorize [--source <slug>] [settings...] [--wait]',
    flags: {
      source: { type: 'string' },
      wait: { type: 'boolean' },
      timeout: { type: 'string' },
      ...CONFIG_FLAGS,
    },
  },
  'datasources promote': {
    usage:
      'Usage: mindstudio-prod datasources promote [--source <slug>] [--force]',
    flags: { source: { type: 'string' }, force: { type: 'boolean' } },
  },
  'datasources drop': {
    usage:
      'Usage: mindstudio-prod datasources drop [--source <slug>] [--version <n>]',
    flags: { source: { type: 'string' }, version: { type: 'string' } },
  },
} satisfies Record<string, CommandSpec>;

const base = (appId: string) => `/_internal/v2/apps/${appId}/datasources`;
const sourceOf = (a: Args) => a.str('source') || DEFAULT_SOURCE;

/**
 * Add one or more documents.
 *
 * Three steps per file, and the middle one is why this isn't a simple POST:
 * the client hashes the bytes first, so the server can answer "already
 * ingested and current" before anything is transferred. Re-running this over
 * an unchanged corpus moves no bytes and embeds nothing.
 *
 * The upload itself goes straight to storage via a presigned POST, so document
 * size isn't bounded by the API's JSON body limit.
 */
async function dataSourcesAdd(appId: string, a: Args) {
  const files = a.rest('file');
  const slug = sourceOf(a);
  const results: any[] = [];

  for (const file of files) {
    const abs = path.isAbsolute(file) ? file : path.join(WORKSPACE_DIR, file);

    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(abs);
    } catch (err: any) {
      fatal(`Could not read file "${file}": ${err.message}`);
    }

    const filename = path.basename(file);
    const contentHash = createHash('sha256').update(bytes!).digest('hex');

    const token = await api('POST', `${base(appId)}/upload-token`, {
      slug,
      filename,
      contentHash,
    });

    if (token.alreadyCurrent) {
      progress(`${filename}: unchanged, skipped`);
      results.push({ filename, skipped: true, document: token.document });
      continue;
    }

    progress(
      `${filename}: uploading ${(bytes!.length / 1024 / 1024).toFixed(1)}MB…`,
    );
    await uploadDirect(token.upload, bytes!, filename);

    const confirmed = await api('POST', `${base(appId)}/documents`, {
      slug,
      filename,
      contentHash,
      contentType: token.contentType,
      size: bytes!.length,
    });

    results.push({
      filename,
      skipped: false,
      queued: confirmed.queued,
      document: confirmed.document,
    });
  }

  if (a.bool('wait')) {
    const timeoutSec = a.num('timeout');
    const timeoutMs = timeoutSec ? timeoutSec * 1000 : DEFAULT_WAIT_TIMEOUT_MS;
    await waitForIngest(
      appId,
      slug,
      results.filter((r) => !r.skipped).map((r) => r.document.id),
      timeoutMs,
    );
    return;
  }

  out({ dataSource: slug, documents: results });
}

/** Submit the presigned POST. Bytes go to storage, never through the API. */
async function uploadDirect(
  upload: { uploadUrl: string; uploadFields: Record<string, string> },
  bytes: Buffer,
  filename: string,
): Promise<void> {
  const form = new FormData();
  for (const [key, value] of Object.entries(upload.uploadFields)) {
    form.append(key, value);
  }
  form.append('file', new Blob([new Uint8Array(bytes)]), filename);

  const res = await fetch(upload.uploadUrl, { method: 'POST', body: form });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    fatal(
      `Upload of "${filename}" failed: ${res.status} ${res.statusText}${
        detail ? ` — ${detail.slice(0, 300)}` : ''
      }`,
    );
  }
}

/**
 * Poll until every queued document reaches a terminal state.
 *
 * Blocking rather than returning a job id is deliberate: the caller is usually
 * the build agent, and it needs to know the corpus is searchable *before* it
 * writes code that searches it. Mirrors `releases wait` — same poll shape, same
 * timeout guard, same distinct exit codes.
 */
async function waitForIngest(
  appId: string,
  slug: string,
  documentIds: string[],
  timeoutMs: number,
): Promise<void> {
  if (documentIds.length === 0) {
    out({ dataSource: slug, status: 'up-to-date', documents: [] });
    return;
  }

  const wanted = new Set(documentIds);
  const start = Date.now();

  for (;;) {
    // A transient failure keeps the last known state; the timeout below still
    // applies, so a persistent error can't loop forever.
    const { documents } = await api(
      'GET',
      `${base(appId)}/documents?slug=${encodeURIComponent(slug)}`,
    );
    const tracked = (documents ?? []).filter((d: any) => wanted.has(d.id));
    const pending = tracked.filter((d: any) => d.status === 'processing');
    const failed = tracked.filter((d: any) => d.status === 'error');

    if (pending.length === 0) {
      const summary = {
        dataSource: slug,
        status: failed.length ? 'error' : 'done',
        documents: tracked.map(summarize),
      };
      if (failed.length) {
        out(summary);
        process.exit(EXIT.buildFailed);
      }
      out(summary);
      return;
    }

    if (Date.now() - start > timeoutMs) {
      out({
        dataSource: slug,
        status: 'timeout',
        error: `Timed out after ${Math.round(timeoutMs / 1000)}s with ${pending.length} document(s) still processing`,
        documents: tracked.map(summarize),
      });
      process.exit(EXIT.timeout);
    }

    progress(
      `ingesting… ${tracked.length - pending.length}/${tracked.length} done (${Math.round(
        (Date.now() - start) / 1000,
      )}s)`,
    );
    await sleep(POLL_MS);
  }
}

const summarize = (d: any) => ({
  id: d.id,
  filename: d.filename,
  status: d.status,
  chunks: d.chunkCount,
  pages: d.pageCount,
  ...(d.errorMessage ? { error: d.errorMessage } : {}),
});

async function dataSourcesList(appId: string) {
  out(await api('GET', base(appId)));
}

async function dataSourcesStatus(appId: string, a: Args) {
  const slug = sourceOf(a);
  const { documents } = await api(
    'GET',
    `${base(appId)}/documents?slug=${encodeURIComponent(slug)}`,
  );
  out({ dataSource: slug, documents: (documents ?? []).map(summarize) });
}

async function dataSourcesRm(appId: string, a: Args) {
  const documentId = a.str('document');
  if (!documentId) {
    fatal('--document is required.');
  }
  await api('POST', `${base(appId)}/documents/delete`, {
    slug: sourceOf(a),
    documentId,
  });
  out({ deleted: documentId });
}

async function dataSourcesSearch(appId: string, a: Args) {
  const topK = a.num('top-k');
  const retrieval = {
    ...triState(a, 'rerank', 'rerank'),
    ...triState(a, 'hybrid', 'hybrid'),
  };
  out(
    await api('POST', `${base(appId)}/search`, {
      slug: sourceOf(a),
      query: a.req('query'),
      ...(topK ? { topK } : {}),
      ...(a.bool('candidate') ? { candidate: true } : {}),
      ...(Object.keys(retrieval).length ? { retrieval } : {}),
    }),
  );
}

/**
 * Read a tri-state boolean flag.
 *
 * Returns `{}` when the flag is absent, so a caller can spread the result and
 * send only what was actually asked for. Without that distinction "don't touch
 * reranking" and "turn reranking off" look identical on the wire.
 */
function triState(a: Args, flag: string, key: string): Record<string, boolean> {
  const raw = a.str(flag);
  if (raw === undefined) {
    return {};
  }
  if (raw !== 'true' && raw !== 'false') {
    fatal(`--${flag} must be "true" or "false" (got "${raw}").`);
  }
  return { [key]: raw === 'true' };
}

/**
 * Split CLI flags into the two halves of the config model.
 *
 * The split isn't cosmetic: `ingest` settings invalidate every stored vector
 * and can only be changed through a re-vectorize, while `retrieval` settings
 * take effect on the next query for free. Keeping them apart on the wire is
 * what lets the server apply one and refuse the other.
 */
function configFromFlags(a: Args): { ingest: any; retrieval: any } {
  const chunking: any = {};
  if (a.num('max-chars') !== undefined) {
    chunking.maxChars = a.num('max-chars');
  }
  if (a.num('min-chars') !== undefined) {
    chunking.minChars = a.num('min-chars');
  }
  const dropBlocks = a.str('drop-blocks');
  if (dropBlocks !== undefined) {
    chunking.dropBlockTypes = dropBlocks
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  const contextual = triState(a, 'contextual', 'enabled');
  const embeddingModel = a.str('embedding-model');
  const extractionModel = a.str('extraction-model');

  const ingest: any = {};
  if (Object.keys(chunking).length) {
    ingest.chunking = chunking;
  }
  if (Object.keys(contextual).length) {
    ingest.contextual = contextual;
  }
  if (embeddingModel) {
    ingest.embedding = { modelId: embeddingModel };
  }
  if (extractionModel) {
    ingest.extraction = { modelId: extractionModel };
  }

  const retrieval: any = { ...triState(a, 'hybrid', 'hybrid') };
  const rerank = triState(a, 'rerank', 'enabled');
  if (Object.keys(rerank).length) {
    retrieval.rerank = rerank;
  }
  if (a.num('top-k') !== undefined) {
    retrieval.topK = a.num('top-k');
  }

  return {
    ingest: Object.keys(ingest).length ? ingest : undefined,
    retrieval: Object.keys(retrieval).length ? retrieval : undefined,
  };
}

/** Show config, or change it when any setting flag is present. */
async function dataSourcesConfig(appId: string, a: Args) {
  const slug = sourceOf(a);
  const { ingest, retrieval } = configFromFlags(a);

  if (!ingest && !retrieval) {
    out(
      await api(
        'GET',
        `${base(appId)}/config?slug=${encodeURIComponent(slug)}`,
      ),
    );
    return;
  }

  out(
    await api('POST', `${base(appId)}/config`, {
      slug,
      ...(ingest ? { ingest } : {}),
      ...(retrieval ? { retrieval } : {}),
    }),
  );
}

/**
 * Build a new pipeline version alongside the live one.
 *
 * With no settings, adopts the platform's current defaults — the upgrade path
 * for a corpus pinned to an older chunker. Search keeps serving the active
 * version throughout; nothing changes until `promote`.
 */
async function dataSourcesRevectorize(appId: string, a: Args) {
  const slug = sourceOf(a);
  const { ingest } = configFromFlags(a);

  const started = await api('POST', `${base(appId)}/revectorize`, {
    slug,
    ...(ingest ? { ingest } : {}),
  });

  if (!a.bool('wait')) {
    out({ dataSource: slug, ...started, note: 'Run `promote` when ready.' });
    return;
  }

  const timeoutSec = a.num('timeout');
  const timeoutMs = timeoutSec ? timeoutSec * 1000 : DEFAULT_WAIT_TIMEOUT_MS;
  const start = Date.now();

  for (;;) {
    const { documents } = await api(
      'GET',
      `${base(appId)}/documents?slug=${encodeURIComponent(slug)}&candidate=true`,
    );
    const pending = (documents ?? []).filter(
      (d: any) => d.status === 'processing',
    );
    const failed = (documents ?? []).filter((d: any) => d.status === 'error');

    if (pending.length === 0) {
      out({
        dataSource: slug,
        candidateVersion: started.candidateVersion,
        status: failed.length ? 'error' : 'ready',
        documents: (documents ?? []).map(summarize),
        note: failed.length
          ? 'Some documents failed. Promote with --force to accept, or fix and re-run.'
          : 'Run `promote` to make this version live.',
      });
      if (failed.length) {
        process.exit(EXIT.buildFailed);
      }
      return;
    }

    if (Date.now() - start > timeoutMs) {
      out({
        dataSource: slug,
        status: 'timeout',
        error: `Timed out after ${Math.round(timeoutMs / 1000)}s with ${pending.length} document(s) still building`,
      });
      process.exit(EXIT.timeout);
    }

    progress(
      `rebuilding… ${documents.length - pending.length}/${documents.length} done (${Math.round(
        (Date.now() - start) / 1000,
      )}s)`,
    );
    await sleep(POLL_MS);
  }
}

async function dataSourcesPromote(appId: string, a: Args) {
  out(
    await api('POST', `${base(appId)}/promote`, {
      slug: sourceOf(a),
      ...(a.bool('force') ? { force: true } : {}),
    }),
  );
}

async function dataSourcesDrop(appId: string, a: Args) {
  const version = a.str('version');
  out(
    await api('POST', `${base(appId)}/versions/drop`, {
      slug: sourceOf(a),
      ...(version ? { version: Number(version) } : {}),
    }),
  );
}

export const dataSourcesHandlers = {
  'datasources add': dataSourcesAdd,
  'datasources list': dataSourcesList,
  'datasources status': dataSourcesStatus,
  'datasources rm': dataSourcesRm,
  'datasources search': dataSourcesSearch,
  'datasources config': dataSourcesConfig,
  'datasources revectorize': dataSourcesRevectorize,
  'datasources promote': dataSourcesPromote,
  'datasources drop': dataSourcesDrop,
} satisfies Record<keyof typeof dataSourcesSpecs, Handler>;

export const dataSourcesHelp = `mindstudio-prod datasources — Build and query a searchable document corpus.

Documents are parsed, chunked and embedded by the platform. Search returns
matching passages with a citation pointing back at the source document.

Subcommands:
  add          Add one or more documents (skips unchanged files)
  list         List data sources with document counts
  status       Show per-document ingest state
  rm           Remove a document and its vectors
  search       Query a corpus — useful to sanity-check one you just built
  config       Show or change how a corpus is processed and searched
  revectorize  Rebuild a corpus under new settings, alongside the live one
  promote      Make a rebuilt version live
  drop         Discard a candidate or a superseded version

Usage:
  mindstudio-prod datasources add [--source <slug>] [--wait] [--timeout <sec>] <file...>
  mindstudio-prod datasources list
  mindstudio-prod datasources status [--source <slug>]
  mindstudio-prod datasources rm [--source <slug>] --document <id>
  mindstudio-prod datasources search [--source <slug>] [--top-k <n>] [--candidate] <query>
  mindstudio-prod datasources config [--source <slug>] [settings...]
  mindstudio-prod datasources revectorize [--source <slug>] [settings...] [--wait]
  mindstudio-prod datasources promote [--source <slug>] [--force]
  mindstudio-prod datasources drop [--source <slug>] [--version <n>]

Tuning a corpus:
  There is no single chunking or retrieval setup that suits every dataset, so
  these are yours to change. Settings come in two kinds, and the difference is
  what a change costs you:

  FREE — take effect on the next search, no rebuild:
    --rerank <true|false>    Cross-encoder reranking (default true)
    --hybrid <true|false>    Semantic + keyword matching (default true)
    --top-k <n>              Default results per search

  REBUILD — change how documents become vectors, so existing documents must be
  reprocessed. Changing these on a corpus that already has documents is
  REJECTED; use \`revectorize\` instead, which builds a new version alongside
  the live one so search never degrades:
    --max-chars <n>          Target chunk size (default 2000)
    --min-chars <n>          Merge chunks smaller than this (default 120)
    --drop-blocks <a,b>      Block types to discard, e.g. footer,header
    --contextual <true|false>  LLM context blurb per chunk. Improves retrieval
                             on long documents; costs a model call per chunk
                             at ingest. Off by default — measure on your data.
    --describe-images <true|false>  Vision pass over images inside documents,
                             substituting a description into the searchable
                             text. ON by default: a document with no images
                             costs nothing, and an undescribed chart is
                             invisible to search rather than merely ranked low.
    --image-model <id>
    --embedding-model <id>
    --extraction-model <id>

Notes:
  --source defaults to "${DEFAULT_SOURCE}" and is created on first use.
  --wait blocks until processing finishes, so you can search immediately after.
    Exits ${EXIT.buildFailed} if a document failed, ${EXIT.timeout} on timeout.
  Re-adding an unchanged file is free: no upload, no re-embedding.
  Re-vectorizing reuses stored extractions, so changing chunking never re-runs
  document extraction — only re-chunking and re-embedding.

Examples:
  mindstudio-prod datasources add --source policies --wait docs/*.pdf
  mindstudio-prod datasources search --source policies "what are the payment terms?"

  # Try smaller chunks without touching what's live, then compare and cut over
  mindstudio-prod datasources revectorize --source policies --max-chars 900 --wait
  mindstudio-prod datasources search --source policies --candidate "payment terms"
  mindstudio-prod datasources promote --source policies
`;
