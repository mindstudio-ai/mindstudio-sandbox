import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { type Args, type CommandSpec } from '../args.js';
import { api } from '../api.js';
import { WORKSPACE_DIR } from '../config.js';
import { fatal } from '../errors.js';
import { out, progress } from '../output.js';
import type { Handler } from '../types.js';
import { uploadDirect } from '../upload.js';

const DEFAULT_STORE = 'assets';

const ACCESS_FLAGS = {
  public: { type: 'boolean' },
  private: { type: 'boolean' },
} as const;

export const filesSpecs = {
  'files put': {
    usage:
      'Usage: mindstudio-prod files put [--public|--private] [--store <name>] [--key <key>] [--content-type <mime>] [--cache-control <value>] <file>',
    positionals: [{ name: 'file', required: true }],
    flags: {
      ...ACCESS_FLAGS,
      store: { type: 'string' },
      key: { type: 'string' },
      'content-type': { type: 'string' },
      'cache-control': { type: 'string' },
    },
  },
  'files get': {
    usage:
      'Usage: mindstudio-prod files get [--public|--private] [--store <name>] [--out <path>] <key>',
    positionals: [{ name: 'key', required: true }],
    flags: {
      ...ACCESS_FLAGS,
      store: { type: 'string' },
      out: { type: 'string' },
    },
  },
  'files sign': {
    usage:
      'Usage: mindstudio-prod files sign [--public|--private] [--store <name>] [--ttl <seconds>] --key <key>',
    flags: {
      ...ACCESS_FLAGS,
      store: { type: 'string' },
      key: { type: 'string' },
      ttl: { type: 'number', min: 1 },
    },
  },
  'files stat': {
    usage:
      'Usage: mindstudio-prod files stat [--public|--private] [--store <name>] --key <key>',
    flags: {
      ...ACCESS_FLAGS,
      store: { type: 'string' },
      key: { type: 'string' },
    },
  },
  'files ls': {
    usage:
      'Usage: mindstudio-prod files ls [--public|--private] [--store <name>] [--prefix <prefix>] [--q <substring>] [--cursor <cursor>] [--limit <n>]',
    flags: {
      ...ACCESS_FLAGS,
      store: { type: 'string' },
      prefix: { type: 'string' },
      q: { type: 'string' },
      cursor: { type: 'string' },
      limit: { type: 'number', min: 1 },
    },
  },
  'files list': {
    usage: 'Usage: mindstudio-prod files list',
  },
  'files rm': {
    usage:
      'Usage: mindstudio-prod files rm --store <name> --key <key> [--private]',
    flags: {
      ...ACCESS_FLAGS,
      store: { type: 'string' },
      key: { type: 'string' },
    },
  },
} satisfies Record<string, CommandSpec>;

// Default public (the marquee use is baking public marketing assets); --private
// overrides. If both are passed, private wins (fail safe).
function resolveAccess(a: Args): 'public' | 'private' {
  return a.bool('private') ? 'private' : 'public';
}

function storeOf(a: Args): string {
  return a.str('store') || DEFAULT_STORE;
}

function requireKeyFlag(a: Args): string {
  const key = a.str('key');
  if (!key) {
    fatal('--key is required.');
  }
  return key;
}

/** Query string for the object-addressed GET endpoints (url / metadata / ls). */
function objectQuery(a: Args, key?: string): URLSearchParams {
  const qs = new URLSearchParams({
    store: storeOf(a),
    access: resolveAccess(a),
  });
  if (key) {
    qs.set('key', key);
  }
  return qs;
}

/**
 * Upload via a presigned POST: the API mints `{ uploadUrl, uploadFields, url }`
 * and the bytes go straight to storage — no JSON-body size cap (up to 5 GiB;
 * `maxSize` pins the presign to exactly this file's size).
 */
async function filesPut(appId: string, a: Args) {
  const file = a.req('file');
  const abs = path.isAbsolute(file) ? file : path.join(WORKSPACE_DIR, file);

  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(abs);
  } catch (err: any) {
    fatal(`Could not read file "${file}": ${err.message}`);
  }

  const access = resolveAccess(a);
  const store = storeOf(a);
  // Content-addressed by default: idempotent + immutable, so a baked-in URL
  // never rots. --key gives a stable, overwritable name.
  const key =
    a.str('key') ||
    `${createHash('sha256').update(bytes).digest('hex')}${path.extname(file)}`;
  const contentType = a.str('content-type');
  // Content-addressed keys are never reused → cache forever. A --key'd
  // (overwritable) object falls through to the server default (public,
  // max-age=300) unless --cache-control overrides it.
  const cacheControl =
    a.str('cache-control') ||
    (!a.str('key') && access === 'public'
      ? 'public, max-age=31536000, immutable'
      : undefined);

  const presign = await api(
    'POST',
    `/_internal/v2/apps/${appId}/file-storage/upload-url`,
    {
      store,
      access,
      key,
      maxSize: bytes.length,
      ...(contentType ? { contentType } : {}),
      ...(cacheControl ? { cacheControl } : {}),
    },
  );

  progress(`uploading ${(bytes.length / 1024 / 1024).toFixed(1)}MB…`);
  await uploadDirect(
    { uploadUrl: presign.uploadUrl, uploadFields: presign.uploadFields },
    bytes,
    path.basename(file),
  );

  out({ key: presign.key, url: presign.url });
}

/** Mint a read link (private → short-lived presigned; public → permanent) and
 *  stream the bytes to disk. */
async function filesGet(appId: string, a: Args) {
  const key = a.req('key');
  const qs = objectQuery(a, key);
  if (resolveAccess(a) === 'private') {
    qs.set('ttl', '60');
  }
  const { url } = await api(
    'GET',
    `/_internal/v2/apps/${appId}/file-storage/url?${qs}`,
  );

  const outPath = a.str('out') || path.basename(key);
  const abs = path.isAbsolute(outPath)
    ? outPath
    : path.join(WORKSPACE_DIR, outPath);

  // Plain fetch (the link is self-authorizing) — no timeout on the byte
  // transfer itself; large objects are the whole point of this command.
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    fatal(`Download failed: ${res.status} ${res.statusText}`);
  }
  await pipeline(
    Readable.fromWeb(res.body as import('node:stream/web').ReadableStream),
    fs.createWriteStream(abs),
  );
  out({ path: abs, size: fs.statSync(abs).size });
}

/** Print a shareable link: private → signed + expiring ({ url, expiresAt },
 *  ttl clamped server-side to [60s, 7d], default 300); public → permanent. */
async function filesSign(appId: string, a: Args) {
  const qs = objectQuery(a, requireKeyFlag(a));
  const ttl = a.num('ttl');
  if (ttl) {
    qs.set('ttl', String(ttl));
  }
  out(await api('GET', `/_internal/v2/apps/${appId}/file-storage/url?${qs}`));
}

/** Object metadata (size, contentType, updatedAt, scan status) — no download.
 *  Missing key → 404, so this doubles as an existence check. */
async function filesStat(appId: string, a: Args) {
  const qs = objectQuery(a, requireKeyFlag(a));
  out(
    await api('GET', `/_internal/v2/apps/${appId}/file-storage/metadata?${qs}`),
  );
}

/** List objects in one store (--q → server-side substring search). */
async function filesLs(appId: string, a: Args) {
  const qs = objectQuery(a);
  for (const flag of ['prefix', 'q', 'cursor'] as const) {
    const value = a.str(flag);
    if (value) {
      qs.set(flag, value);
    }
  }
  const limit = a.num('limit');
  if (limit) {
    qs.set('limit', String(limit));
  }
  out(await api('GET', `/_internal/v2/apps/${appId}/file-storage?${qs}`));
}

/** Store-level summary: every store with object counts + total bytes. */
async function filesList(appId: string) {
  out(await api('GET', `/_internal/v2/apps/${appId}/file-storage/summary`));
}

async function filesRm(appId: string, a: Args) {
  const store = a.str('store');
  const key = a.str('key');
  if (!store) {
    fatal('--store is required.');
  }
  if (!key) {
    fatal('--key is required.');
  }
  out(
    await api('POST', `/_internal/v2/apps/${appId}/file-storage/delete`, {
      store,
      access: resolveAccess(a),
      keys: [key],
    }),
  );
}

export const filesHandlers = {
  'files put': filesPut,
  'files get': filesGet,
  'files sign': filesSign,
  'files stat': filesStat,
  'files ls': filesLs,
  'files list': filesList,
  'files rm': filesRm,
} satisfies Record<keyof typeof filesSpecs, Handler>;

export const filesHelp = `mindstudio-prod files — Store, retrieve, and share files in the app's stores.

Subcommands:
  put    Upload a file (any size up to 5 GiB — bytes go directly to storage) and print its long-lived URL
  get    Download an object to disk
  sign   Print a shareable link (private → signed + expiring; public → permanent)
  stat   Object metadata without downloading (404 = doesn't exist)
  ls     List objects in a store (prefix filter or substring search)
  list   Summary of all stores (object counts + total bytes)
  rm     Delete an object from a store

Usage:
  mindstudio-prod files put [--public|--private] [--store <name>] [--key <key>] [--cache-control <value>] <file>
  mindstudio-prod files get [--private] [--store <name>] [--out <path>] <key>
  mindstudio-prod files sign [--private] [--store <name>] [--ttl <seconds>] --key <key>
  mindstudio-prod files stat [--private] [--store <name>] --key <key>
  mindstudio-prod files ls [--private] [--store <name>] [--prefix <prefix>] [--q <substring>] [--limit <n>]
  mindstudio-prod files list
  mindstudio-prod files rm --store <name> --key <key> [--private]

Examples:
  mindstudio-prod files put --public ./hero.jpg
  mindstudio-prod files put --private --store handoff ./export.tar.gz
  mindstudio-prod files sign --private --store handoff --key <key> --ttl 86400
  mindstudio-prod files get --private --store handoff --out ./export.tar.gz <key>
  mindstudio-prod files rm --store handoff --key <key> --private

Notes:
  - Defaults to a public store named 'assets'; pass --private / --store to change.
  - Handing someone a large or sensitive file? Use a PRIVATE store + \`sign\`:
    the link is unguessable, expires (--ttl seconds, max 7 days), and the object
    stays deletable with \`rm\`. Never use the account media CDN
    (\`mindstudio upload\`) for sensitive material — those URLs are public and
    permanent.
  - put: the key defaults to a content hash (sha256) of the bytes, so
    re-uploading the same file is idempotent and its URL is safe to bake into
    source. Pass --key for a stable, overwritable name (e.g. a config JSON the
    frontend fetches).
  - CDN caching follows the object's Cache-Control: content-hash keys default to
    immutable (cache-forever); --key'd objects default to public, max-age=300 so
    an overwrite propagates within ~5 minutes. Pass --cache-control to override.
  - Public image URLs accept transform params, e.g. ?w=400&fit=cover.`;
