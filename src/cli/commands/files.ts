import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { type Args, type CommandSpec } from '../args.js';
import { api } from '../api.js';
import { WORKSPACE_DIR } from '../config.js';
import { fatal } from '../errors.js';
import { out } from '../output.js';
import type { Handler } from '../types.js';

const DEFAULT_STORE = 'assets';

export const filesSpecs = {
  'files put': {
    usage:
      'Usage: mindstudio-prod files put [--public|--private] [--store <name>] [--key <key>] [--content-type <mime>] <file>',
    positionals: [{ name: 'file', required: true }],
    flags: {
      public: { type: 'boolean' },
      private: { type: 'boolean' },
      store: { type: 'string' },
      key: { type: 'string' },
      'content-type': { type: 'string' },
    },
  },
  'files list': {
    usage: 'Usage: mindstudio-prod files list',
  },
  'files rm': {
    usage:
      'Usage: mindstudio-prod files rm --store <name> --key <key> [--private]',
    flags: {
      store: { type: 'string' },
      key: { type: 'string' },
      public: { type: 'boolean' },
      private: { type: 'boolean' },
    },
  },
} satisfies Record<string, CommandSpec>;

// Default public (the marquee use is baking public marketing assets); --private
// overrides. If both are passed, private wins (fail safe).
function resolveAccess(a: Args): 'public' | 'private' {
  return a.bool('private') ? 'private' : 'public';
}

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
  const store = a.str('store') || DEFAULT_STORE;
  // Content-addressed by default: idempotent + immutable, so a baked-in URL
  // never rots. --key gives a stable, overwritable name.
  const key =
    a.str('key') ||
    `${createHash('sha256').update(bytes).digest('hex')}${path.extname(file)}`;
  const contentType = a.str('content-type');

  out(
    await api('POST', `/_internal/v2/apps/${appId}/files`, {
      store,
      access,
      key,
      ...(contentType ? { contentType } : {}),
      body: bytes.toString('base64'),
    }),
  );
}

async function filesList(appId: string) {
  out(await api('GET', `/_internal/v2/apps/${appId}/files/summary`));
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
    await api('POST', `/_internal/v2/apps/${appId}/files/delete`, {
      store,
      access: resolveAccess(a),
      keys: [key],
    }),
  );
}

export const filesHandlers = {
  'files put': filesPut,
  'files list': filesList,
  'files rm': filesRm,
} satisfies Record<keyof typeof filesSpecs, Handler>;

export const filesHelp = `mindstudio-prod files — Store files on the app's CDN (build-time).

Subcommands:
  put    Upload a file and print its long-lived URL (embed it in your site)
  list   List stores with object counts + total bytes
  rm     Delete an object from a store

Usage:
  mindstudio-prod files put [--public|--private] [--store <name>] [--key <key>] <file>
  mindstudio-prod files list
  mindstudio-prod files rm --store <name> --key <key> [--private]

Examples:
  mindstudio-prod files put --public ./hero.jpg
  mindstudio-prod files put --public --store branding --key logo.svg ./logo.svg
  mindstudio-prod files list
  mindstudio-prod files rm --store assets --key logo.svg

Notes:
  - Defaults to a public store named 'assets'; pass --private / --store to change.
  - The key defaults to a content hash (sha256) of the bytes, so re-uploading
    the same file is idempotent and its URL is safe to bake into source. Pass
    --key for a stable, overwritable name (e.g. a config JSON the frontend fetches).
  - Public image URLs accept transform params, e.g. ?w=400&fit=cover.`;
